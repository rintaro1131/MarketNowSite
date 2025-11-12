(() => {
  'use strict';

  // ---------- Utilities ----------
  const DEFAULT_INTERVAL_SEC = 60;
  const STORE_KEY = 'market-now-state-v1';

  const fmtJPY = new Intl.NumberFormat('ja-JP', { style:'currency', currency:'JPY', maximumFractionDigits:2 });
  const fmtUSD = new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', maximumFractionDigits:2 });
  const fmtPlain = new Intl.NumberFormat('en-US', { maximumFractionDigits:2 });

  /* タイムアウト付きfetch（iOS安定：AbortController不使用） */
  async function fetchWithTimeout(input, { timeout = 9000, as = "text", init = {} } = {}) {
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Timeout ${timeout}ms: ${typeof input === 'string' ? input : ''}`)), timeout)
    );
    const res = await Promise.race([ fetch(input, { cache: 'no-store', redirect: 'follow', ...init }), timeoutPromise ]);
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status}: ${typeof input === 'string' ? input : ''}`);
    return as === "json" ? res.json() : res.text();
  }
  async function fetchJson(url, timeout=9000) { return fetchWithTimeout(url, { timeout, as: "json" }); }
  async function fetchText(url, timeout=9000) { return fetchWithTimeout(url, { timeout, as: "text" }); }

  // GitHub Pages判定（/api は使えないのでスキップ）
  function onGitHubPagesHost() {
    return /\.github\.io$/i.test(location.hostname);
  }

  function qs(sel) { return document.querySelector(sel); }

  function getSearchParam(name) {
    try { return new URL(location.href).searchParams.get(name); } catch { return null; }
  }

  function toJstString(date) {
    const d = (date instanceof Date) ? date : new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss} JST`;
  }

  // ---------- Data Fetchers ----------
  async function getUsdJpy() {
    // Try Frankfurter -> fallback to open.er-api
    try {
      const url = 'https://api.frankfurter.dev/latest?from=USD&to=JPY';
      const json = await fetchJson(url);
      const rate = json && json.rates && Number(json.rates.JPY);
      if (!Number.isFinite(rate)) throw new Error('Frankfurter no rate');
      return { rate, source: 'Frankfurter' };
    } catch (e1) {
      try {
        const url2 = 'https://open.er-api.com/v6/latest/USD';
        const json2 = await fetchJson(url2);
        const rate2 = json2 && json2.rates && Number(json2.rates.JPY);
        if (!Number.isFinite(rate2)) throw new Error('er-api no rate');
        return { rate: rate2, source: 'open.er-api' };
      } catch (e2) {
        throw e2;
      }
    }
  }

  async function getCrypto() {
    const urls = {
      btcUsd: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      btcJpy: 'https://api.coinbase.com/v2/prices/BTC-JPY/spot',
      ethUsd: 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
      ethJpy: 'https://api.coinbase.com/v2/prices/ETH-JPY/spot',
    };

    const [bUsd, bJpy, eUsd, eJpy] = await Promise.all([
      fetchJson(urls.btcUsd).then(d => Number(d?.data?.amount)).catch(() => null),
      fetchJson(urls.btcJpy).then(d => Number(d?.data?.amount)).catch(() => null),
      fetchJson(urls.ethUsd).then(d => Number(d?.data?.amount)).catch(() => null),
      fetchJson(urls.ethJpy).then(d => Number(d?.data?.amount)).catch(() => null),
    ]);

    const btcOk = Number.isFinite(bUsd) && Number.isFinite(bJpy);
    const ethOk = Number.isFinite(eUsd) && Number.isFinite(eJpy);

    if (!btcOk && !ethOk) {
      // Signal overall failure to let caller mark stale with cache
      const err = new Error('Crypto fetch failed');
      err.partial = { btc: { usd: bUsd, jpy: bJpy }, eth: { usd: eUsd, jpy: eJpy } };
      throw err;
    }

    return {
      btc: { usd: bUsd, jpy: bJpy, stale: !btcOk },
      eth: { usd: eUsd, jpy: eJpy, stale: !ethOk },
      source: 'Coinbase'
    };
  }

  /* S&P500 取得：FMP → 自前キャッシュ → 複数プロキシ */
  async function getSPX() {
    const params = new URLSearchParams(location.search);
    const fmpKey = params.get('fmp');

    // 1) FMP（任意・最優先）
    if (fmpKey) {
      try {
        const j = await fetchJson(`https://financialmodelingprep.com/api/v3/quote/%5EGSPC?apikey=${encodeURIComponent(fmpKey)}`, 10000);
        if (Array.isArray(j) && j[0] && Number.isFinite(+j[0].price)) {
          console.info('[SPX] via FMP');
          return { value: +j[0].price, label: 'Live-ish (FMP)', source: 'fmp' };
        }
      } catch(e){ console.warn('[SPX] FMP failed -> fallback', e); }
    }

    // 2) 自前キャッシュ（GitHub Pages でも確実 /data/spx.json）
    try {
      const c = await fetchJson('./data/spx.json?ts=' + Date.now(), 6000);
      if (c && Number.isFinite(+c.value)) {
        console.info('[SPX] via local cache JSON');
        return { value: +c.value, date: c.date, label: 'EOD (cache)', source: 'cache' };
      }
    } catch(e){ console.warn('[SPX] cache json failed -> fallback', e); }

    // 3) CORS可プロキシ（r.jina.ai）を複数試行（^ を二重エンコード %255E）
    const targets = [
      'https://r.jina.ai/https://stooq.com/q/d/l/?s=%255Espx&i=d',
      'https://r.jina.ai/http://stooq.com/q/d/l/?s=%255Espx&i=d',
      'https://r.jina.ai/http://stooq.pl/q/d/l/?s=%255Espx&i=d',
      'https://r.jina.ai/https://stooq.com/q/l/?s=%255Espx&i=',
      'https://r.jina.ai/http://stooq.com/q/l/?s=%255Espx&i=',
      'https://r.jina.ai/https://query1.finance.yahoo.com/v7/finance/quote?symbols=%255EGSPC'
    ];
    for (const url of targets) {
      try {
        const txt = await fetchText(url, 10000);
        const t = txt.trim();
        let val, date;
        if (/^\d{4}-\d{2}-\d{2},/m.test(t)) {
          const arr = t.split('\n').pop().split(',');
          date = arr[0]; val = Number(arr[4]);
        } else if (t.startsWith('^')) {
          const arr = t.split('\n').pop().split(',');
          val = Number(arr[1]);
        } else if (t.includes('"regularMarketPrice"')) {
          const j = JSON.parse(t);
          const q = j?.quoteResponse?.result?.[0];
          if (q && Number.isFinite(+q.regularMarketPrice)) {
            val = +q.regularMarketPrice;
          }
        }
        if (Number.isFinite(val)) {
          console.info('[SPX] via proxy:', url);
          return { value: val, date, label: 'EOD (proxy)', source: 'proxy' };
        }
      } catch(e){
        console.warn('[SPX] proxy failed -> next', url, e);
      }
    }
    throw new Error('All SPX sources failed');
  }

  // ---------- State ----------
  const state = {
    lastData: null,
    lastUpdated: null,
    sources: { fx: null, crypto: 'Coinbase', spx: null },
    intervalSec: DEFAULT_INTERVAL_SEC,
    failureCount: 0,
    timerId: null,
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        state.lastData = obj.lastData ?? null;
        state.lastUpdated = obj.lastUpdated ?? null;
        state.intervalSec = obj.intervalSec ?? DEFAULT_INTERVAL_SEC;
        if (obj.source) state.sources = obj.source; // backward compat
        if (obj.sources) state.sources = obj.sources;
      }
    } catch {}
  }

  function saveState() {
    const payload = {
      lastData: state.lastData,
      lastUpdated: state.lastUpdated,
      intervalSec: state.intervalSec,
      sources: state.sources,
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch {}
  }

  // ---------- Rendering ----------
  function render() {
    const d = state.lastData;
    // FX
    if (d?.fx) {
      qs('#fx-value').textContent = Number.isFinite(d.fx.rate) ? fmtJPY.format(d.fx.rate) : '—';
      qs('#fx-sub').textContent = Number.isFinite(d.fx.rate)
        ? `1 USD = ${fmtPlain.format(d.fx.rate)} JPY`
        : '1 USD = — JPY';
      qs('#fx-stale').hidden = !d.fx.stale;
    }

    // SPX
    if (d?.spx) {
      qs('#spx-value').textContent = Number.isFinite(d.spx.value) ? fmtPlain.format(d.spx.value) : '—';
      qs('#spx-sub').textContent = d.spx.label || '';
      qs('#spx-stale').hidden = !d.spx.stale;
    }

    // BTC
    if (d?.crypto?.btc) {
      const b = d.crypto.btc;
      qs('#btc-usd-value').textContent = Number.isFinite(b.usd) ? fmtUSD.format(b.usd) : '—';
      qs('#btc-jpy-value').textContent = Number.isFinite(b.jpy) ? fmtJPY.format(b.jpy) : '—';
      qs('#btc-stale').hidden = !b.stale;
    }

    // ETH
    if (d?.crypto?.eth) {
      const e = d.crypto.eth;
      qs('#eth-usd-value').textContent = Number.isFinite(e.usd) ? fmtUSD.format(e.usd) : '—';
      qs('#eth-jpy-value').textContent = Number.isFinite(e.jpy) ? fmtJPY.format(e.jpy) : '—';
      qs('#eth-stale').hidden = !e.stale;
    }

    // Footer time + sources
    qs('#lastUpdated').textContent = state.lastUpdated
      ? `最終更新：${toJstWithTZ(new Date(state.lastUpdated))}`
      : '最終更新：—';

    // Asterisk if FMP used
    const fmpAst = qs('#fmp-asterisk');
    if (state.sources?.spx === 'FMP') fmpAst.hidden = false; else fmpAst.hidden = true;
  }

  function toJstWithTZ(d) {
    try {
      // Convert to Asia/Tokyo time
      const zdt = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const pad = (n) => String(n).padStart(2, '0');
      const y = zdt.getFullYear();
      const m = pad(zdt.getMonth() + 1);
      const day = pad(zdt.getDate());
      const hh = pad(zdt.getHours());
      const mm = pad(zdt.getMinutes());
      const ss = pad(zdt.getSeconds());
      return `${y}-${m}-${day} ${hh}:${mm}:${ss} JST`;
    } catch {
      return toJstString(d);
    }
  }

  // ---------- Refresh Logic ----------
  async function refreshAll(manual = false) {
    setLoading(true);
    const prev = state.lastData || {};

    const fxP = getUsdJpy().then(v => ({ ok: true, value: v })).catch(err => ({ ok: false, err }));
    const spxP = getSPX().then(v => ({ ok: true, value: v })).catch(err => ({ ok: false, err }));
    const cP = getCrypto().then(v => ({ ok: true, value: v })).catch(err => ({ ok: false, err }));

    const [fxR, spxR, cR] = await Promise.all([fxP, spxP, cP]);

    const newData = {
      fx: prev.fx || { rate: NaN, source: null, stale: true },
      spx: prev.spx || { value: NaN, label: 'EOD (Stooq)', source: null, stale: true },
      crypto: {
        btc: (prev.crypto && prev.crypto.btc) || { usd: NaN, jpy: NaN, stale: true },
        eth: (prev.crypto && prev.crypto.eth) || { usd: NaN, jpy: NaN, stale: true },
      },
    };

    // FX
    if (fxR.ok) {
      newData.fx.rate = fxR.value.rate;
      newData.fx.source = fxR.value.source;
      newData.fx.stale = false;
      state.sources.fx = fxR.value.source;
    } else {
      newData.fx.stale = true;
    }

    // SPX
    if (spxR.ok) {
      newData.spx.value = spxR.value.value;
      newData.spx.label = spxR.value.label;
      newData.spx.source = spxR.value.source;
      newData.spx.stale = false;
      state.sources.spx = spxR.value.source;
    } else {
      newData.spx.stale = true;
    }

    // Crypto
    if (cR.ok) {
      const c = cR.value;
      if (Number.isFinite(c.btc.usd)) newData.crypto.btc.usd = c.btc.usd;
      if (Number.isFinite(c.btc.jpy)) newData.crypto.btc.jpy = c.btc.jpy;
      if (Number.isFinite(c.eth.usd)) newData.crypto.eth.usd = c.eth.usd;
      if (Number.isFinite(c.eth.jpy)) newData.crypto.eth.jpy = c.eth.jpy;
      newData.crypto.btc.stale = c.btc.stale;
      newData.crypto.eth.stale = c.eth.stale;
      state.sources.crypto = c.source;
    } else {
      // Partial values may exist in error.partial
      const p = cR.err && cR.err.partial;
      if (p) {
        if (Number.isFinite(p.btc?.usd)) newData.crypto.btc.usd = p.btc.usd;
        if (Number.isFinite(p.btc?.jpy)) newData.crypto.btc.jpy = p.btc.jpy;
        if (Number.isFinite(p.eth?.usd)) newData.crypto.eth.usd = p.eth.usd;
        if (Number.isFinite(p.eth?.jpy)) newData.crypto.eth.jpy = p.eth.jpy;
      }
      newData.crypto.btc.stale = true;
      newData.crypto.eth.stale = true;
    }

    state.lastData = newData;
    state.lastUpdated = Date.now();
    saveState();
    render();

    // Backoff scheduling: 60 -> 120 -> 180 on failures
    const anyFailed = !(fxR.ok && spxR.ok && cR.ok);
    state.failureCount = anyFailed ? Math.min(state.failureCount + 1, 2) : 0;
    scheduleNext();
    setLoading(false);
  }

  function scheduleNext() {
    if (state.timerId) clearTimeout(state.timerId);
    const base = state.intervalSec;
    const factor = state.failureCount === 0 ? 1 : (state.failureCount === 1 ? 2 : 3);
    const delayMs = base * factor * 1000;
    state.timerId = setTimeout(() => refreshAll(false), delayMs);
  }

  function setLoading(loading) {
    const btn = qs('#refreshBtn');
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }

  // ---------- Init ----------
  function init() {
    loadState();
    // Populate interval select
    const sel = qs('#intervalSelect');
    sel.value = String(state.intervalSec || DEFAULT_INTERVAL_SEC);
    sel.addEventListener('change', () => {
      const v = Number(sel.value);
      state.intervalSec = Number.isFinite(v) ? v : DEFAULT_INTERVAL_SEC;
      saveState();
      scheduleNext();
    });

    // Refresh button
    qs('#refreshBtn').addEventListener('click', () => refreshAll(true));

    // Render cache first
    if (state.lastData) {
      render();
    }
    // Then fetch live
    refreshAll(false);
  }

  // Helper to ensure initial footer format when cached
  document.addEventListener('DOMContentLoaded', () => {
    init();
  });
})();
