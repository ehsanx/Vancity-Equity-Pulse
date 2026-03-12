import { useState, useMemo, useCallback, Fragment } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from "recharts";

/* ═══════════════════════════════════════════════════════════════════════
   VANCOUVER BUY vs RENT WEALTH SIMULATOR — Full Public Release
   Features: Leasehold/Freehold, BC PTT, CMHC, Mortgage Renewal,
   Tax Sheltering, Market/Subsidized Rent, Real $, Monte Carlo
   ═══════════════════════════════════════════════════════════════════════ */

// ── Formatters ──────────────────────────────────────────────────────
const cadM = (v) => {
  if (v == null || isNaN(v)) return "$0";
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};
const fmtCAD = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(v || 0);
const pct = (v) => `${Number(v).toFixed(1)}%`;

// ── BC Property Transfer Tax ────────────────────────────────────────
function calcBCPTT(price) {
  if (price <= 0) return 0;
  let tax = 0;
  if (price > 2000000) tax += (price - 2000000) * 0.03;
  if (price > 200000) tax += (Math.min(price, 2000000) - 200000) * 0.02;
  tax += Math.min(price, 200000) * 0.01;
  // Additional PTT for properties > $3M (2% surcharge on amount over $3M)
  if (price > 3000000) tax += (price - 3000000) * 0.02;
  return Math.round(tax);
}

// ── BC Selling Costs ────────────────────────────────────────────────
function calcSellingCosts(price) {
  // Realtor: ~7% first $100K + 2.5% remainder (BC standard, negotiable)
  // Legal + admin: ~$3K
  if (price <= 0) return 0;
  const realtor = Math.min(price, 100000) * 0.07 + Math.max(0, price - 100000) * 0.025;
  return Math.round(realtor + 3000);
}

// ── CMHC Insurance ──────────────────────────────────────────────────
function calcCMHC(mortgage, purchasePrice) {
  const ltv = mortgage / purchasePrice;
  if (ltv <= 0.80) return 0;
  // CMHC premium rates (on mortgage amount)
  let rate = 0;
  if (ltv <= 0.85) rate = 0.028;
  else if (ltv <= 0.90) rate = 0.031;
  else if (ltv <= 0.95) rate = 0.04;
  else return 0; // >95% not allowed
  return Math.round(mortgage * rate);
}

// ── Canadian mortgage math (semi-annual compounding) ────────────────
const caMonthlyRate = (ar) => Math.pow(1 + ar / 2, 1 / 6) - 1;
const calcPmt = (P, ar, yrs) => {
  if (!P || P <= 0) return 0;
  const r = caMonthlyRate(ar), n = yrs * 12;
  return P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
};

// ── Leasehold decay factor ──────────────────────────────────────────
// As remaining lease years drop, appreciation decays
function leaseholdDecay(remainingYears) {
  if (remainingYears >= 70) return 1.0;
  if (remainingYears >= 50) return 0.5 + 0.5 * ((remainingYears - 50) / 20);
  if (remainingYears >= 30) return 0.15 + 0.35 * ((remainingYears - 30) / 20);
  return Math.max(0, 0.15 * (remainingYears / 30));
}

// ── Box-Muller for Monte Carlo ──────────────────────────────────────
function randNormal(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Core simulation engine ──────────────────────────────────────────
function simulate(cfg) {
  const {
    isBuy, purchasePrice, mortgage, mortgageRate, amortYears,
    fixedHousing, housingInfl, initialPortfolio,
    budgetCap0, capGrowth, reAppr, investRet, years,
    // New features
    isLeasehold, leaseYearsRemaining, freeholdAppr,
    includePTT, includeSelling, includeCMHC, cmhcAmount,
    renewalAdjust, renewalEvery,
    taxDrag, // 0 = fully sheltered, e.g. 0.15 = 15% drag
    cpi, // for real-dollar deflation
    // Monte Carlo randomness
    returnVolatility, reVolatility, seed,
  } = cfg;

  const pttCost = (isBuy && includePTT) ? calcBCPTT(purchasePrice) : 0;
  const totalMortgage = mortgage + ((isBuy && includeCMHC) ? cmhcAmount : 0);
  let currentRate = mortgageRate;
  let bal = totalMortgage;
  let hv = purchasePrice;
  let port = Math.max(0, initialPortfolio - pttCost); // PTT reduces initial capital
  let housing = fixedHousing;
  let cap = budgetCap0;
  let cumU = 0;
  let pmt = isBuy ? calcPmt(totalMortgage, currentRate, amortYears) : 0;
  let leaseRemaining = leaseYearsRemaining || 99;
  const snaps = [];

  for (let yr = 0; yr <= years; yr++) {
    const equity = isBuy ? Math.max(0, hv - bal) : 0;
    // Selling costs reduce realized equity
    const sellingCost = (isBuy && includeSelling && yr > 0) ? calcSellingCosts(hv) : 0;
    const netEquity = Math.max(0, equity - sellingCost);
    const deflator = cpi > 0 ? Math.pow(1 + cpi, yr) : 1;

    snaps.push({
      yr,
      hv: Math.round(hv),
      bal: Math.round(bal),
      equity: Math.round(netEquity),
      grossEquity: Math.round(equity),
      sellingCost: Math.round(sellingCost),
      pttPaid: yr === 0 ? pttCost : 0,
      port: Math.round(port),
      nw: Math.round(netEquity + port),
      nwReal: Math.round((netEquity + port) / deflator),
      housing: Math.round(housing),
      cap: Math.round(cap),
      pmt: Math.round(pmt),
      tot: isBuy ? Math.round(pmt + housing) : Math.round(housing),
      cumU: Math.round(cumU),
      rate: currentRate,
      leaseRemaining: Math.round(leaseRemaining),
    });

    if (yr < years) {
      // Mortgage renewal
      if (isBuy && renewalEvery > 0 && yr > 0 && yr % renewalEvery === 0 && bal > 0) {
        currentRate = mortgageRate + renewalAdjust;
        const remainingAmort = amortYears - yr;
        if (remainingAmort > 0) {
          pmt = calcPmt(bal, currentRate, remainingAmort);
        }
      }

      // Monthly loop
      const r = caMonthlyRate(currentRate);
      const effectiveInvestRet = investRet * (1 - taxDrag);
      // Randomized returns for Monte Carlo
      const yearRetInvest = returnVolatility > 0
        ? Math.max(-0.30, randNormal(effectiveInvestRet, returnVolatility))
        : effectiveInvestRet;
      const monthRetInvest = yearRetInvest / 12;

      for (let m = 0; m < 12; m++) {
        if (isBuy) {
          const interest = bal * r;
          bal = Math.max(0, bal - Math.max(0, pmt - interest));
          const surplus = Math.max(0, cap - pmt - housing);
          port = port * (1 + monthRetInvest) + surplus;
          cumU += interest + housing;
        } else {
          const surplus = Math.max(0, cap - housing);
          port = port * (1 + monthRetInvest) + surplus;
          cumU += housing;
        }
      }

      // RE appreciation with leasehold decay
      if (isBuy) {
        const yearReAppr = reVolatility > 0
          ? Math.max(-0.15, randNormal(reAppr, reVolatility))
          : reAppr;
        if (isLeasehold) {
          const decay = leaseholdDecay(leaseRemaining);
          hv *= 1 + yearReAppr * decay;
          leaseRemaining -= 1;
        } else {
          const effectiveAppr = freeholdAppr !== undefined ? freeholdAppr : reAppr;
          const yearFreeAppr = reVolatility > 0
            ? Math.max(-0.15, randNormal(effectiveAppr, reVolatility))
            : effectiveAppr;
          hv *= 1 + yearFreeAppr;
        }
      }

      housing *= 1 + housingInfl;
      cap *= 1 + capGrowth;
    }
  }
  return snaps;
}

// ── Monte Carlo runner ──────────────────────────────────────────────
function runMonteCarlo(baseCfg, nRuns, years) {
  const allRuns = [];
  for (let i = 0; i < nRuns; i++) {
    allRuns.push(simulate({ ...baseCfg, seed: i }));
  }
  // Compute percentiles per year
  const bands = [];
  for (let yr = 0; yr <= years; yr++) {
    const nws = allRuns.map(r => r[yr].nw).sort((a, b) => a - b);
    bands.push({
      yr,
      p10: nws[Math.floor(nRuns * 0.1)],
      p25: nws[Math.floor(nRuns * 0.25)],
      p50: nws[Math.floor(nRuns * 0.5)],
      p75: nws[Math.floor(nRuns * 0.75)],
      p90: nws[Math.floor(nRuns * 0.9)],
    });
  }
  return bands;
}

// ── Scenario colors/meta ────────────────────────────────────────────
const SCEN_META = [
  { id: "A", color: "#e11d48", icon: "🏠", isBuy: true },
  { id: "B", color: "#f97316", icon: "🏡", isBuy: true },
  { id: "C", color: "#22c55e", icon: "🌿", isBuy: false },
  { id: "D", color: "#3b82f6", icon: "🏘", isBuy: false },
];

// ── Collapsible section ─────────────────────────────────────────────
function Section({ title, icon, open, onToggle, accent = "#94a3b8", children }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <button onClick={onToggle}
        style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${open ? accent + "40" : "#334155"}`, background: open ? accent + "08" : "#1e293b", color: open ? accent : "#94a3b8", cursor: "pointer", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{icon} {title}</span>
        <span style={{ fontSize: 13, transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform .2s" }}>▾</span>
      </button>
      {open && <div style={{ background: "#1e293b", borderRadius: "0 0 8px 8px", padding: 12, border: "1px solid #334155", borderTop: "none" }}>{children}</div>}
    </div>
  );
}

// ── Reusable input components ───────────────────────────────────────
function NumField({ label, value, onChange, prefix = "$", suffix = "", step = 1000, min = 0, max = 99999999 }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ fontSize: 10.5, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {prefix && <span style={{ fontSize: 11, color: "#475569", fontFamily: "monospace" }}>{prefix}</span>}
        <input type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 7px", color: "#f1f5f9", fontFamily: "monospace", fontSize: 12, outline: "none" }} />
        {suffix && <span style={{ fontSize: 11, color: "#475569", fontFamily: "monospace", whiteSpace: "nowrap" }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange, hint }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7, gap: 6 }}>
      <div>
        <div style={{ fontSize: 10.5, color: "#94a3b8" }}>{label}</div>
        {hint && <div style={{ fontSize: 9, color: "#475569" }}>{hint}</div>}
      </div>
      <div onClick={() => onChange(!value)}
        style={{ width: 34, height: 18, borderRadius: 9, background: value ? "#22c55e" : "#334155", cursor: "pointer", position: "relative", transition: "background .2s", flexShrink: 0 }}>
        <div style={{ width: 14, height: 14, borderRadius: 7, background: "white", position: "absolute", top: 2, left: value ? 18 : 2, transition: "left .2s" }} />
      </div>
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ fontSize: 10.5, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 7px", color: "#f1f5f9", fontSize: 11, outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Slider({ label, value, onChange, min, max, step, unit, accent = "#94a3b8" }) {
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12, color: accent }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: accent, cursor: "pointer" }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#334155" }}>
        <span>{min}{unit}</span><span>{max}{unit}</span>
      </div>
    </div>
  );
}

// ── Chart tooltip ───────────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload) return null;
  return (
    <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", fontSize: 12, maxWidth: 280 }}>
      <div style={{ color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>Year {label}</div>
      {payload.filter(p => !p.dataKey?.includes("_")).map((p, i) => (
        <div key={i} style={{ color: p.color || "#94a3b8", display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span style={{ fontSize: 11 }}>{p.name}</span>
          <span style={{ fontWeight: 700, fontFamily: "monospace" }}>{cadM(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const Panel = ({ children, style = {} }) => (
  <div style={{ background: "#1e293b", borderRadius: 12, padding: 14, border: "1px solid #334155", marginBottom: 10, ...style }}>{children}</div>
);

const TABS = [
  { id: "nw", label: "Net Worth" },
  { id: "port", label: "Portfolios" },
  { id: "cash", label: "Cash Flows" },
  { id: "mc", label: "Monte Carlo" },
  { id: "table", label: "Table" },
];

// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════
export default function VancouverHousingSim() {
  const [tab, setTab] = useState("nw");

  // ── Section visibility ────────────────────────────────────────────
  const [openSections, setOpenSections] = useState({});
  const toggleSection = useCallback((k) => setOpenSections(p => ({ ...p, [k]: !p[k] })), []);

  // ── Basic inputs ──────────────────────────────────────────────────
  const [inputs, setInputs] = useState({
    initialCapital: 300000, budgetCap0: 10000,
    A_price: 2000000, A_downPct: 20, A_strata: 3000, A_tenure: "leasehold",
    B_price: 1500000, B_downPct: 20, B_strata: 1500, B_tenure: "freehold",
    C_rent: 4300, C_type: "subsidized",
    D_rent: 6300, D_type: "market",
  });
  const si = useCallback((k, v) => setInputs(p => ({ ...p, [k]: v })), []);

  // ── Rate assumptions ──────────────────────────────────────────────
  const [rates, setRates] = useState({
    investReturn: 6.0, leaseholdAppr: 3.0, freeholdAppr: 5.0,
    mortgageRate: 4.5, budgetCapGrowth: 4.0,
    subsidizedRentInfl: 2.0, marketRentInfl: 3.5, strataInfl: 3.0,
    horizonYears: 15,
  });
  const sr = useCallback((k, v) => setRates(p => ({ ...p, [k]: v })), []);

  // ── Advanced toggles ──────────────────────────────────────────────
  const [adv, setAdv] = useState({
    includePTT: true, includeSelling: true, includeCMHC: true,
    renewalEnabled: true, renewalEvery: 5, renewalAdjust: 0.5,
    taxSheltered: true, marginalRate: 35,
    showReal: false, cpi: 2.0,
    leaseYears: 99,
    mcEnabled: false, mcRuns: 150, returnVol: 12, reVol: 6,
  });
  const sa = useCallback((k, v) => setAdv(p => ({ ...p, [k]: v })), []);

  // ── Build scenarios ───────────────────────────────────────────────
  const SCEN = useMemo(() => {
    const cap = inputs.initialCapital;
    return SCEN_META.map(m => {
      if (m.isBuy) {
        const key = m.id;
        const price = inputs[key + "_price"];
        const downPct = inputs[key + "_downPct"];
        const down = price * downPct / 100;
        const mortgage = price - down;
        const cmhc = adv.includeCMHC ? calcCMHC(mortgage, price) : 0;
        const ptt = adv.includePTT ? calcBCPTT(price) : 0;
        const residual = Math.max(0, cap - down - ptt);
        const tenure = inputs[key + "_tenure"];
        const shortLabel = tenure === "leasehold" ? `Buy ${cadM(price)} LH` : `Buy ${cadM(price)} FH`;
        return {
          ...m, label: shortLabel, short: shortLabel,
          badge: tenure === "leasehold" ? "Leasehold" : "Freehold",
          purchasePrice: price, downPayment: down, mortgage, cmhc, ptt,
          strataMonthly: inputs[key + "_strata"], initPortfolio: residual,
          isLeasehold: tenure === "leasehold",
        };
      } else {
        const key = m.id;
        const rentType = inputs[key + "_type"];
        const label = rentType === "subsidized" ? `Rent ${fmtCAD(inputs[key + "_rent"])} Sub` : `Rent ${fmtCAD(inputs[key + "_rent"])} Mkt`;
        return {
          ...m, label, short: label, badge: rentType === "subsidized" ? "Subsidized" : "Market",
          rentMonthly: inputs[key + "_rent"], initPortfolio: cap, rentType,
        };
      }
    });
  }, [inputs, adv.includeCMHC, adv.includePTT]);

  // ── Run deterministic simulations ─────────────────────────────────
  const { results, chartNW, chartPort, chartCash, chartUR, finals, winner, crossovers, oppCost } = useMemo(() => {
    const taxDrag = adv.taxSheltered ? 0 : (adv.marginalRate / 100) * 0.5; // ~50% of returns are cap gains
    const R = {};
    SCEN.forEach(s => {
      R[s.id] = simulate({
        isBuy: s.isBuy,
        purchasePrice: s.isBuy ? s.purchasePrice : 0,
        mortgage: s.isBuy ? s.mortgage : 0,
        mortgageRate: rates.mortgageRate / 100,
        amortYears: 25,
        fixedHousing: s.isBuy ? s.strataMonthly : s.rentMonthly,
        housingInfl: s.isBuy ? rates.strataInfl / 100 : (s.rentType === "subsidized" ? rates.subsidizedRentInfl / 100 : rates.marketRentInfl / 100),
        initialPortfolio: s.initPortfolio,
        budgetCap0: inputs.budgetCap0,
        capGrowth: rates.budgetCapGrowth / 100,
        reAppr: rates.leaseholdAppr / 100,
        freeholdAppr: rates.freeholdAppr / 100,
        investRet: rates.investReturn / 100,
        years: rates.horizonYears,
        isLeasehold: s.isLeasehold || false,
        leaseYearsRemaining: adv.leaseYears,
        includePTT: adv.includePTT,
        includeSelling: adv.includeSelling,
        includeCMHC: adv.includeCMHC,
        cmhcAmount: s.cmhc || 0,
        renewalAdjust: adv.renewalEnabled ? adv.renewalAdjust / 100 : 0,
        renewalEvery: adv.renewalEnabled ? adv.renewalEvery : 0,
        taxDrag,
        cpi: adv.showReal ? adv.cpi / 100 : 0,
        returnVolatility: 0, reVolatility: 0,
      });
    });

    const nwKey = adv.showReal ? "nwReal" : "nw";
    const nwData = [], portData = [], cashData = [], urData = [];
    for (let yr = 0; yr <= rates.horizonYears; yr++) {
      const nwRow = { yr }, portRow = { yr }, cashRow = { yr }, urRow = { yr };
      SCEN.forEach(s => {
        const snap = R[s.id][yr];
        nwRow[s.id] = adv.showReal ? snap.nwReal : snap.nw;
        portRow[s.id] = snap.port;
        cashRow[s.id] = snap.tot;
        urRow[s.id] = snap.cumU;
      });
      cashRow.cap = R.A[yr].cap;
      nwData.push(nwRow); portData.push(portRow);
      cashData.push(cashRow); urData.push(urRow);
    }

    const fins = Object.fromEntries(SCEN.map(s => [s.id, R[s.id][rates.horizonYears]]));
    const finNW = (id) => adv.showReal ? (fins[id]?.nwReal || 0) : (fins[id]?.nw || 0);
    const w = SCEN.reduce((b, s) => finNW(s.id) > finNW(b.id) ? s : b, SCEN[0]);
    const xov = {};
    ["B", "C", "D"].forEach(id => {
      for (let yr = 1; yr <= rates.horizonYears; yr++) {
        const aNW = adv.showReal ? R.A[yr]?.nwReal : R.A[yr]?.nw;
        const sNW = adv.showReal ? R[id][yr]?.nwReal : R[id][yr]?.nw;
        if ((sNW || 0) > (aNW || 0)) { xov[id] = yr; break; }
      }
    });
    const opp = Math.round(inputs.initialCapital * Math.pow(1 + rates.investReturn / 100 * (1 - taxDrag), rates.horizonYears));
    return { results: R, chartNW: nwData, chartPort: portData, chartCash: cashData, chartUR: urData, finals: fins, winner: w, crossovers: xov, oppCost: opp };
  }, [SCEN, rates, inputs.budgetCap0, inputs.initialCapital, adv]);

  // ── Monte Carlo ───────────────────────────────────────────────────
  const mcData = useMemo(() => {
    if (!adv.mcEnabled) return null;
    const taxDrag = adv.taxSheltered ? 0 : (adv.marginalRate / 100) * 0.5;
    const allBands = {};
    SCEN.forEach(s => {
      const baseCfg = {
        isBuy: s.isBuy,
        purchasePrice: s.isBuy ? s.purchasePrice : 0,
        mortgage: s.isBuy ? s.mortgage : 0,
        mortgageRate: rates.mortgageRate / 100,
        amortYears: 25,
        fixedHousing: s.isBuy ? s.strataMonthly : s.rentMonthly,
        housingInfl: s.isBuy ? rates.strataInfl / 100 : (s.rentType === "subsidized" ? rates.subsidizedRentInfl / 100 : rates.marketRentInfl / 100),
        initialPortfolio: s.initPortfolio,
        budgetCap0: inputs.budgetCap0,
        capGrowth: rates.budgetCapGrowth / 100,
        reAppr: rates.leaseholdAppr / 100,
        freeholdAppr: rates.freeholdAppr / 100,
        investRet: rates.investReturn / 100,
        years: rates.horizonYears,
        isLeasehold: s.isLeasehold || false,
        leaseYearsRemaining: adv.leaseYears,
        includePTT: adv.includePTT, includeSelling: adv.includeSelling,
        includeCMHC: adv.includeCMHC, cmhcAmount: s.cmhc || 0,
        renewalAdjust: adv.renewalEnabled ? adv.renewalAdjust / 100 : 0,
        renewalEvery: adv.renewalEnabled ? adv.renewalEvery : 0,
        taxDrag, cpi: 0,
        returnVolatility: adv.returnVol / 100,
        reVolatility: adv.reVol / 100,
      };
      allBands[s.id] = runMonteCarlo(baseCfg, adv.mcRuns, rates.horizonYears);
    });
    // Merge into chart data
    const merged = [];
    for (let yr = 0; yr <= rates.horizonYears; yr++) {
      const row = { yr };
      SCEN.forEach(s => {
        const b = allBands[s.id][yr];
        row[s.id + "_p10"] = b.p10;
        row[s.id + "_p25"] = b.p25;
        row[s.id + "_p50"] = b.p50;
        row[s.id + "_p75"] = b.p75;
        row[s.id + "_p90"] = b.p90;
      });
      merged.push(row);
    }
    return merged;
  }, [adv.mcEnabled, adv.mcRuns, adv.returnVol, adv.reVol, SCEN, rates, inputs.budgetCap0, inputs.initialCapital, adv.includePTT, adv.includeSelling, adv.includeCMHC, adv.renewalEnabled, adv.renewalAdjust, adv.renewalEvery, adv.taxSheltered, adv.marginalRate, adv.leaseYears, rates.leaseholdAppr, rates.freeholdAppr]);

  const finNW = (id) => adv.showReal ? (finals[id]?.nwReal || 0) : (finals[id]?.nw || 0);
  const yTickFmt = (v) => cadM(v);

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div style={{ background: "#0f172a", color: "#f1f5f9", minHeight: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 13 }}>

      {/* ── HEADER ───────────────────────────────────────────────────── */}
      <div style={{ background: "linear-gradient(135deg,#0f172a,#1e293b)", borderBottom: "1px solid #334155", padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, background: "linear-gradient(135deg,#f1f5f9,#94a3b8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Vancouver Housing Wealth Simulator
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>
            Buy (leasehold / freehold) vs Rent · BC costs · Monte Carlo · {adv.showReal ? "Real" : "Nominal"} CAD
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {SCEN.map(s => (
            <span key={s.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 20, fontSize: 10, border: `1px solid ${s.color}40`, background: s.color + "15", color: "#f1f5f9" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color, display: "inline-block" }} />
              {s.short}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, padding: "12px 16px" }}>

        {/* ═══ SIDEBAR ════════════════════════════════════════════════ */}
        <div style={{ width: 240, flexShrink: 0 }}>

          {/* ── Scenarios Setup ──────────────────────────────────────── */}
          <Section title="Scenario Setup" icon="✏️" open={openSections.setup} onToggle={() => toggleSection("setup")} accent="#93c5fd">
            <NumField label="Initial Liquid Capital" value={inputs.initialCapital} onChange={v => si("initialCapital", v)} step={10000} />
            <NumField label="Monthly Budget Cap" value={inputs.budgetCap0} onChange={v => si("budgetCap0", v)} step={500} />

            {["A", "B"].map(id => (
              <div key={id} style={{ borderTop: "1px solid #334155", marginTop: 10, paddingTop: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: SCEN_META.find(s => s.id === id).color, marginBottom: 6 }}>
                  {SCEN_META.find(s => s.id === id).icon} Scenario {id} — Buy
                </div>
                <NumField label="Purchase Price" value={inputs[id + "_price"]} onChange={v => si(id + "_price", v)} step={50000} />
                <NumField label="Down Payment" value={inputs[id + "_downPct"]} onChange={v => si(id + "_downPct", v)} prefix="" suffix="%" step={1} min={5} max={100} />
                <NumField label="Strata + Maint /mo" value={inputs[id + "_strata"]} onChange={v => si(id + "_strata", v)} step={100} />
                <SelectField label="Tenure Type" value={inputs[id + "_tenure"]} onChange={v => si(id + "_tenure", v)}
                  options={[{ value: "leasehold", label: "Leasehold (99-yr)" }, { value: "freehold", label: "Freehold" }]} />
              </div>
            ))}

            {["C", "D"].map(id => (
              <div key={id} style={{ borderTop: "1px solid #334155", marginTop: 10, paddingTop: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: SCEN_META.find(s => s.id === id).color, marginBottom: 6 }}>
                  {SCEN_META.find(s => s.id === id).icon} Scenario {id} — Rent
                </div>
                <NumField label="Monthly Rent" value={inputs[id + "_rent"]} onChange={v => si(id + "_rent", v)} step={100} />
                <SelectField label="Rent Type" value={inputs[id + "_type"]} onChange={v => si(id + "_type", v)}
                  options={[{ value: "subsidized", label: "Subsidized / Institutional" }, { value: "market", label: "Market Rate" }]} />
              </div>
            ))}
          </Section>

          {/* ── Rate Sliders ─────────────────────────────────────────── */}
          <Panel>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#64748b", marginBottom: 8 }}>Rate Assumptions</div>
            <Slider label="Investment Return" value={rates.investReturn} onChange={v => sr("investReturn", v)} min={2} max={12} step={0.5} unit="%" accent="#22d3ee" />
            <Slider label="Leasehold Appreciation" value={rates.leaseholdAppr} onChange={v => sr("leaseholdAppr", v)} min={0} max={6} step={0.5} unit="%" accent="#fb923c" />
            <Slider label="Freehold Appreciation" value={rates.freeholdAppr} onChange={v => sr("freeholdAppr", v)} min={1} max={8} step={0.5} unit="%" accent="#f59e0b" />
            <Slider label="Mortgage Rate" value={rates.mortgageRate} onChange={v => sr("mortgageRate", v)} min={2} max={8} step={0.25} unit="%" accent="#e11d48" />
            <Slider label="Budget Cap Growth" value={rates.budgetCapGrowth} onChange={v => sr("budgetCapGrowth", v)} min={0} max={6} step={0.5} unit="%" accent="#a78bfa" />
            <Slider label="Subsidized Rent Infl" value={rates.subsidizedRentInfl} onChange={v => sr("subsidizedRentInfl", v)} min={0} max={5} step={0.5} unit="%" accent="#4ade80" />
            <Slider label="Market Rent Inflation" value={rates.marketRentInfl} onChange={v => sr("marketRentInfl", v)} min={1} max={7} step={0.5} unit="%" accent="#34d399" />
            <Slider label="Strata Inflation" value={rates.strataInfl} onChange={v => sr("strataInfl", v)} min={1} max={7} step={0.5} unit="%" accent="#f87171" />
            <Slider label="Horizon" value={rates.horizonYears} onChange={v => sr("horizonYears", v)} min={5} max={30} step={1} unit=" yr" accent="#94a3b8" />
          </Panel>

          {/* ── BC Transaction Costs ─────────────────────────────────── */}
          <Section title="BC Transaction Costs" icon="🏛" open={openSections.bc} onToggle={() => toggleSection("bc")} accent="#f59e0b">
            <Toggle label="Property Transfer Tax" value={adv.includePTT} onChange={v => sa("includePTT", v)} hint="1% / 2% / 3% tiered" />
            <Toggle label="Selling Costs (Realtor + Legal)" value={adv.includeSelling} onChange={v => sa("includeSelling", v)} hint="~7% first $100K + 2.5% rest" />
            <Toggle label="CMHC Insurance" value={adv.includeCMHC} onChange={v => sa("includeCMHC", v)} hint="Required if down < 20%" />
            {SCEN.filter(s => s.isBuy).map(s => (
              <div key={s.id} style={{ background: "#0f172a", borderRadius: 6, padding: 7, marginTop: 6, fontSize: 10, color: "#94a3b8" }}>
                <span style={{ color: s.color, fontWeight: 700 }}>{s.id}</span>
                {adv.includePTT && <span> · PTT: {fmtCAD(s.ptt)}</span>}
                {adv.includeCMHC && s.cmhc > 0 && <span> · CMHC: {fmtCAD(s.cmhc)}</span>}
                {adv.includeSelling && <span> · Sell @Yr{rates.horizonYears}: ~{fmtCAD(calcSellingCosts(s.purchasePrice * Math.pow(1 + (s.isLeasehold ? rates.leaseholdAppr : rates.freeholdAppr) / 100, rates.horizonYears)))}</span>}
              </div>
            ))}
          </Section>

          {/* ── Mortgage Renewal ──────────────────────────────────────── */}
          <Section title="Mortgage Renewal Risk" icon="🔄" open={openSections.mtg} onToggle={() => toggleSection("mtg")} accent="#e11d48">
            <Toggle label="Enable Renewal Simulation" value={adv.renewalEnabled} onChange={v => sa("renewalEnabled", v)} hint="Rate changes at term renewal" />
            {adv.renewalEnabled && <>
              <NumField label="Term Length (years)" value={adv.renewalEvery} onChange={v => sa("renewalEvery", v)} prefix="" suffix="yr" step={1} min={1} max={10} />
              <Slider label="Rate Δ at Renewal" value={adv.renewalAdjust} onChange={v => sa("renewalAdjust", v)} min={-2} max={3} step={0.25} unit="%" accent="#e11d48" />
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
                Post-renewal rate: {pct(rates.mortgageRate + adv.renewalAdjust)}
              </div>
            </>}
          </Section>

          {/* ── Tax & Inflation ───────────────────────────────────────── */}
          <Section title="Tax & Inflation" icon="📊" open={openSections.tax} onToggle={() => toggleSection("tax")} accent="#a78bfa">
            <Toggle label="Tax-Sheltered (TFSA/RRSP)" value={adv.taxSheltered} onChange={v => sa("taxSheltered", v)} hint="No tax drag on returns" />
            {!adv.taxSheltered && (
              <Slider label="Marginal Tax Rate" value={adv.marginalRate} onChange={v => sa("marginalRate", v)} min={15} max={53} step={1} unit="%" accent="#a78bfa" />
            )}
            <div style={{ borderTop: "1px solid #334155", margin: "8px 0" }} />
            <Toggle label="Show in Real (Inflation-Adjusted) $" value={adv.showReal} onChange={v => sa("showReal", v)} />
            {adv.showReal && (
              <Slider label="CPI Assumption" value={adv.cpi} onChange={v => sa("cpi", v)} min={1} max={5} step={0.5} unit="%" accent="#94a3b8" />
            )}
          </Section>

          {/* ── Leasehold Settings ────────────────────────────────────── */}
          <Section title="Leasehold Details" icon="📜" open={openSections.lease} onToggle={() => toggleSection("lease")} accent="#fb923c">
            <Slider label="Remaining Lease Years" value={adv.leaseYears} onChange={v => sa("leaseYears", v)} min={30} max={99} step={1} unit=" yr" accent="#fb923c" />
            <div style={{ background: "#0f172a", borderRadius: 6, padding: 8, marginTop: 6, fontSize: 10, lineHeight: 1.7, color: "#94a3b8" }}>
              <strong style={{ color: "#fb923c" }}>Decay curve:</strong> Full appreciation above 70yr remaining. Decays to ~50% at 50yr, ~15% at 30yr. This models the well-documented leasehold discount as remaining term shortens.
            </div>
          </Section>

          {/* ── Monte Carlo ───────────────────────────────────────────── */}
          <Section title="Monte Carlo Simulation" icon="🎲" open={openSections.mc} onToggle={() => toggleSection("mc")} accent="#22d3ee">
            <Toggle label="Enable Monte Carlo" value={adv.mcEnabled} onChange={v => sa("mcEnabled", v)} hint="Randomized return paths" />
            {adv.mcEnabled && <>
              <Slider label="Simulations" value={adv.mcRuns} onChange={v => sa("mcRuns", v)} min={50} max={500} step={50} unit="" accent="#22d3ee" />
              <Slider label="Return Volatility (σ)" value={adv.returnVol} onChange={v => sa("returnVol", v)} min={5} max={25} step={1} unit="%" accent="#22d3ee" />
              <Slider label="RE Volatility (σ)" value={adv.reVol} onChange={v => sa("reVol", v)} min={2} max={15} step={1} unit="%" accent="#fb923c" />
            </>}
          </Section>

          {/* ── Crossovers ───────────────────────────────────────────── */}
          <Panel>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#64748b", marginBottom: 8 }}>Crossover vs A</div>
            {["B", "C", "D"].map(id => {
              const s = SCEN.find(x => x.id === id);
              const co = crossovers[id];
              const diff = finNW(id) - finNW("A");
              return (
                <div key={id} style={{ marginBottom: 5, padding: 7, borderRadius: 7, background: "#0f172a", border: `1px solid ${s.color}22` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 11, fontWeight: 700 }}>
                    <span style={{ color: s.color }}>{s.icon} {s.id}</span>
                    <span style={{ color: co ? "#4ade80" : "#475569" }}>{co ? `Yr ${co}` : `>${rates.horizonYears}yr`}</span>
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: diff >= 0 ? "#4ade80" : "#f87171" }}>
                    {diff >= 0 ? "▲ +" : "▼ "}{cadM(Math.abs(diff))}
                  </div>
                </div>
              );
            })}
          </Panel>

          {/* ── Opportunity Cost ──────────────────────────────────────── */}
          <div style={{ background: "#1a1228", borderRadius: 10, padding: 11, border: "1px solid rgba(124,58,237,0.19)", marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#a78bfa", marginBottom: 5 }}>Capital Opportunity Cost</div>
            <div style={{ fontSize: 11, color: "#c4b5fd", lineHeight: 1.6 }}>
              {cadM(inputs.initialCapital)} at {rates.investReturn}%{!adv.taxSheltered ? ` (${adv.marginalRate}% tax)` : ""} × {rates.horizonYears}yr
              <span style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700, color: "#a78bfa", display: "block", margin: "2px 0" }}>{cadM(oppCost)}</span>
            </div>
          </div>

          {/* ── Assumptions ──────────────────────────────────────────── */}
          <div style={{ background: "#0a1a0a", borderRadius: 10, padding: 10, border: "1px solid #15532e", fontSize: 10, color: "#86efac", lineHeight: 1.8 }}>
            <div style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#4ade80", marginBottom: 4, fontSize: 9 }}>Model Notes</div>
            Canadian semi-annual compounding · Budget cap = Sc. A total cost · Surplus invested · PTT paid from capital at purchase · CMHC added to mortgage · Selling costs deducted from equity · Tax drag: ~50% of portfolio return taxed at marginal rate (simplified) · Leasehold decay below 70yr remaining
          </div>
        </div>

        {/* ═══ MAIN ═══════════════════════════════════════════════════ */}
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* Winner Banner */}
          <div style={{ borderRadius: 10, padding: "7px 13px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10, background: `linear-gradient(135deg, ${winner.color}15, ${winner.color}05)`, border: `1px solid ${winner.color}28` }}>
            <span style={{ fontSize: 18 }}>{winner.icon}</span>
            <div>
              <div style={{ fontSize: 10, color: "#64748b" }}>Year {rates.horizonYears} Leader {adv.showReal ? "(Real $)" : "(Nominal)"}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: winner.color }}>{winner.label} · {cadM(finNW(winner.id))}</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, fontSize: 10 }}>
              {adv.includePTT && <span style={{ padding: "2px 6px", borderRadius: 10, background: "#f59e0b15", color: "#f59e0b", border: "1px solid #f59e0b30" }}>PTT</span>}
              {adv.includeSelling && <span style={{ padding: "2px 6px", borderRadius: 10, background: "#f59e0b15", color: "#f59e0b", border: "1px solid #f59e0b30" }}>Sell$</span>}
              {adv.renewalEnabled && <span style={{ padding: "2px 6px", borderRadius: 10, background: "#e11d4815", color: "#e11d48", border: "1px solid #e11d4830" }}>Renew</span>}
              {!adv.taxSheltered && <span style={{ padding: "2px 6px", borderRadius: 10, background: "#a78bfa15", color: "#a78bfa", border: "1px solid #a78bfa30" }}>Taxed</span>}
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 3, marginBottom: 10, background: "#1e293b", borderRadius: 8, padding: 3, width: "fit-content" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ padding: "5px 11px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontWeight: tab === t.id ? 700 : 500, border: "none", background: tab === t.id ? "#3b82f6" : "transparent", color: tab === t.id ? "white" : "#94a3b8", transition: "all .15s" }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── NET WORTH ──────────────────────────────────────────── */}
          {tab === "nw" && (<>
            <Panel>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
                Total Net Worth {adv.showReal ? "(Inflation-Adjusted)" : "(Nominal)"} — Equity + Portfolio
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
                {adv.includeSelling ? "Equity net of selling costs" : "Gross equity"} · Surplus above housing invested at {rates.investReturn}%{!adv.taxSheltered ? ` less ${adv.marginalRate}% tax` : ""}
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartNW}>
                  <XAxis dataKey="yr" stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} />
                  <YAxis stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={yTickFmt} width={60} />
                  <Tooltip content={<ChartTooltip />} />
                  {SCEN.map(s => <Line key={s.id} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} strokeWidth={2.5} dot={false} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </Panel>

            {/* Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7, marginBottom: 10 }}>
              {SCEN.map(s => {
                const d = finals[s.id]; if (!d) return null;
                const nw = finNW(s.id);
                const vsA = nw - finNW("A");
                const isW = s.id === winner.id;
                return (
                  <div key={s.id} style={{ background: "#1e293b", borderRadius: 10, padding: 10, border: `1px solid ${isW ? s.color : "#334155"}`, borderTop: `3px solid ${s.color}`, boxShadow: isW ? `0 0 12px ${s.color}20` : "none" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: s.color }}>{s.id} {s.icon}</span>
                      <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 20, fontWeight: 700, background: s.color + "20", color: s.color }}>{s.badge}</span>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace", margin: "2px 0" }}>{cadM(nw)}</div>
                    {s.id !== "A" && (
                      <div style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: vsA >= 0 ? "#4ade80" : "#f87171", marginBottom: 4 }}>
                        {vsA >= 0 ? "▲ +" : "▼ "}{cadM(Math.abs(vsA))} vs A
                      </div>
                    )}
                    <div style={{ borderTop: "1px solid #334155", paddingTop: 4, marginTop: s.id === "A" ? 6 : 0 }}>
                      {[
                        d.equity > 0 && ["Net Equity", cadM(d.equity), null],
                        ["Portfolio", cadM(d.port), "#22d3ee"],
                        d.hv > 0 && ["Home Value", cadM(d.hv), null],
                        d.bal > 0 && ["Mortgage", cadM(d.bal), "#f87171"],
                        ["Cum. Unrec.", cadM(results[s.id][rates.horizonYears]?.cumU || 0), "#fb923c"],
                        ["Mo. Housing", fmtCAD(d.tot), null],
                        ["Mo. Invested", fmtCAD(Math.max(0, d.cap - d.tot)), "#4ade80"],
                        s.isBuy && s.isLeasehold && ["Lease Rem.", `${d.leaseRemaining}yr`, "#fb923c"],
                      ].filter(Boolean).map(([label, val, clr], i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2.5px 0", borderBottom: "1px solid #0f172a", fontSize: 10 }}>
                          <span style={{ color: "#64748b" }}>{label}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 10.5, fontWeight: 600, color: clr || "#94a3b8" }}>{val}</span>
                        </div>
                      ))}
                    </div>
                    {s.id !== "A" && crossovers[s.id] && (
                      <div style={{ marginTop: 5, background: "#052e16", borderRadius: 5, padding: "2px 6px", fontSize: 9, color: "#4ade80", fontWeight: 700 }}>
                        ✓ Leads A at Yr {crossovers[s.id]}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Composition */}
            <Panel>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 7 }}>Yr {rates.horizonYears} Composition</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7 }}>
                {SCEN.map(s => {
                  const nw = finNW(s.id);
                  const d = finals[s.id]; if (!d || !nw) return null;
                  const ep = nw > 0 ? Math.max(0, d.equity / nw * 100) : 0;
                  const pp = 100 - ep;
                  return (
                    <div key={s.id} style={{ background: "#0f172a", borderRadius: 7, padding: 7, border: `1px solid ${s.color}20` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: s.color }}>{s.id} — {cadM(nw)}</div>
                      <div style={{ height: 20, borderRadius: 4, overflow: "hidden", display: "flex", gap: 1, margin: "4px 0 3px" }}>
                        {ep > 0 && <div style={{ width: `${ep}%`, background: s.color, opacity: 0.5, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {ep > 18 && <span style={{ fontSize: 8, color: "white", fontWeight: 700 }}>EQ</span>}
                        </div>}
                        {pp > 0 && <div style={{ width: `${pp}%`, background: s.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {pp > 18 && <span style={{ fontSize: 8, color: "white", fontWeight: 700 }}>PORT</span>}
                        </div>}
                      </div>
                      <div style={{ fontSize: 9, color: "#64748b", fontFamily: "monospace" }}>
                        {ep > 0 ? `Eq ${ep.toFixed(0)}% ` : ""}Port {pp.toFixed(0)}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </>)}

          {/* ── PORTFOLIOS ─────────────────────────────────────────── */}
          {tab === "port" && (
            <Panel>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Liquid Portfolio Only</div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>Cash-accessible wealth · excludes illiquid home equity</div>
              <ResponsiveContainer width="100%" height={340}>
                <AreaChart data={chartPort}>
                  <XAxis dataKey="yr" stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} />
                  <YAxis stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={yTickFmt} width={60} />
                  <Tooltip content={<ChartTooltip />} />
                  {SCEN.map(s => <Area key={s.id} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} fill={s.color} fillOpacity={0.08} strokeWidth={2.5} dot={false} isAnimationActive={false} />)}
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
          )}

          {/* ── CASH FLOWS ─────────────────────────────────────────── */}
          {tab === "cash" && (<>
            <Panel>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Monthly Housing Outflow</div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>P+I + strata (buy) or rent · dashed = budget cap</div>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={chartCash}>
                  <XAxis dataKey="yr" stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} />
                  <YAxis stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={v => `$${(v / 1e3).toFixed(0)}K`} width={50} />
                  <Tooltip content={<ChartTooltip />} />
                  {SCEN.map(s => <Line key={s.id} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} />)}
                  <Line type="monotone" dataKey="cap" name="Budget Cap" stroke="#475569" strokeWidth={1.5} strokeDasharray="6 3" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
            <Panel>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Cumulative Unrecoverable Costs</div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>Interest + strata (buy) or rent — builds zero wealth</div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartUR}>
                  <XAxis dataKey="yr" stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} />
                  <YAxis stroke="#334155" tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={yTickFmt} width={60} />
                  <Tooltip content={<ChartTooltip />} />
                  {SCEN.map(s => <Line key={s.id} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          </>)}

          {/* ── MONTE CARLO ────────────────────────────────────────── */}
          {tab === "mc" && (
            adv.mcEnabled && mcData ? (
              <Panel>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Monte Carlo — Net Worth Bands</div>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
                  {adv.mcRuns} simulations · σ_invest={adv.returnVol}% · σ_RE={adv.reVol}% · Shaded = P10–P90
                </div>
                {SCEN.map(s => (
                  <div key={s.id} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: s.color, marginBottom: 4 }}>{s.icon} {s.label}</div>
                    <ResponsiveContainer width="100%" height={160}>
                      <AreaChart data={mcData}>
                        <XAxis dataKey="yr" stroke="#334155" tick={{ fill: "#64748b", fontSize: 10 }} />
                        <YAxis stroke="#334155" tick={{ fill: "#64748b", fontSize: 10 }} tickFormatter={yTickFmt} width={55} />
                        <Tooltip content={<ChartTooltip />} />
                        <Area type="monotone" dataKey={s.id + "_p10"} name="P10" stroke="none" fill={s.color} fillOpacity={0.06} isAnimationActive={false} />
                        <Area type="monotone" dataKey={s.id + "_p90"} name="P90" stroke="none" fill={s.color} fillOpacity={0.06} isAnimationActive={false} />
                        <Area type="monotone" dataKey={s.id + "_p25"} name="P25" stroke="none" fill={s.color} fillOpacity={0.12} isAnimationActive={false} />
                        <Area type="monotone" dataKey={s.id + "_p75"} name="P75" stroke="none" fill={s.color} fillOpacity={0.12} isAnimationActive={false} />
                        <Line type="monotone" dataKey={s.id + "_p50"} name="Median" stroke={s.color} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "monospace", color: "#64748b", padding: "2px 4px" }}>
                      <span>P10: {cadM(mcData[rates.horizonYears]?.[s.id + "_p10"] || 0)}</span>
                      <span style={{ color: s.color, fontWeight: 700 }}>P50: {cadM(mcData[rates.horizonYears]?.[s.id + "_p50"] || 0)}</span>
                      <span>P90: {cadM(mcData[rates.horizonYears]?.[s.id + "_p90"] || 0)}</span>
                    </div>
                  </div>
                ))}
              </Panel>
            ) : (
              <Panel>
                <div style={{ textAlign: "center", padding: 30, color: "#64748b" }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>🎲</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Monte Carlo is disabled</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>Enable it in the Monte Carlo section on the left sidebar to see probability bands.</div>
                </div>
              </Panel>
            )
          )}

          {/* ── DATA TABLE ─────────────────────────────────────────── */}
          {tab === "table" && (
            <Panel>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Year-by-Year Output {adv.showReal ? "(Real $)" : ""}</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5, fontFamily: "monospace" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #334155" }}>
                      <th style={{ textAlign: "left", padding: "4px 6px", color: "#64748b" }}>Yr</th>
                      {SCEN.map(s => (
                        <th key={s.id} colSpan={2} style={{ textAlign: "center", padding: "4px 6px", color: s.color, borderLeft: "1px solid #334155" }}>{s.short}</th>
                      ))}
                    </tr>
                    <tr style={{ borderBottom: "1px solid #334155" }}>
                      <th />
                      {SCEN.map(s => (
                        <Fragment key={s.id}>
                          <th style={{ textAlign: "right", padding: "2px 6px", color: "#475569", borderLeft: "1px solid #1e293b", fontSize: 9 }}>NW</th>
                          <th style={{ textAlign: "right", padding: "2px 6px", color: "#475569", fontSize: 9 }}>∑Unrec</th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: rates.horizonYears + 1 }, (_, yr) => {
                      const vals = SCEN.map(s => adv.showReal ? (results[s.id][yr]?.nwReal || 0) : (results[s.id][yr]?.nw || 0));
                      const best = Math.max(...vals);
                      return (
                        <tr key={yr} style={yr % 5 === 0 ? { background: "rgba(51,65,85,.12)" } : {}}>
                          <td style={{ fontWeight: 700, padding: "3px 6px", color: "#f1f5f9" }}>{yr}</td>
                          {SCEN.map((s, si) => {
                            const sn = results[s.id][yr];
                            const nw = vals[si];
                            const isTop = nw === best && best > 0;
                            return (
                              <Fragment key={s.id}>
                                <td style={{ textAlign: "right", padding: "3px 6px", borderLeft: "1px solid #1e293b", fontWeight: isTop ? 700 : 400, color: isTop ? s.color : "#94a3b8", background: isTop ? s.color + "12" : "transparent" }}>{cadM(nw)}</td>
                                <td style={{ textAlign: "right", padding: "3px 6px", color: "#475569" }}>{cadM(sn?.cumU || 0)}</td>
                              </Fragment>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 6, fontSize: 10, color: "#64748b" }}>
                NW = Net Worth · ∑Unrec = Cumulative unrecoverable costs · <span style={{ color: "#4ade80" }}>Highlighted</span> = leader
              </div>
            </Panel>
          )}

          {/* ── HOW IT WORKS ───────────────────────────────────────── */}
          <div style={{ background: "#0d1a2e", borderRadius: 11, padding: 12, border: "1px solid rgba(30,64,175,0.19)", marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#93c5fd", marginBottom: 8 }}>How This Model Works</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
              {[
                ["📐 Budget Cap Rule", "All scenarios equalized to the same monthly budget (Scenario A's full cost). Surplus is invested. Apples-to-apples."],
                ["🏗 Leasehold Decay", "Below 70yr remaining, appreciation decays linearly. At 50yr: ~50%. At 30yr: ~15%. Models real-world leasehold discount."],
                ["🏛 BC Costs", "PTT (1%/2%/3% tiered), CMHC insurance if <20% down, and ~3.5% realtor + legal on sale. All reduce net wealth."],
                ["🔄 Renewal Risk", "Canadian mortgages renew every 5yr. If rates rise at renewal, payments increase on remaining balance."],
                ["📊 Tax Drag", "TFSA/RRSP shelters returns fully. Taxable accounts lose ~50% of returns at your marginal rate (simplified)."],
                ["🎲 Monte Carlo", "Randomizes annual returns (normal distribution) to show P10/P25/P50/P75/P90 outcome bands."],
              ].map(([title, text], i) => (
                <div key={i} style={{ background: "rgba(30,58,95,0.09)", borderRadius: 7, padding: 9, border: "1px solid rgba(30,64,175,0.15)" }}>
                  <strong style={{ display: "block", color: "#93c5fd", fontSize: 11, marginBottom: 2 }}>{title}</strong>
                  <p style={{ color: "#7dd3fc", lineHeight: 1.6, fontSize: 10, margin: 0 }}>{text}</p>
                </div>
              ))}
            </div>
          </div>

          <div style={{ textAlign: "center", padding: "14px 0 6px", fontSize: 9.5, color: "#334155" }}>
            Educational tool only — not financial advice. Consult a qualified planner for your specific situation. Model simplifications noted in sidebar.
          </div>
        </div>
      </div>
    </div>
  );
}