// 共用小工具：讀取 data/watchlist.json、把台股代碼補上 .TW 後綴給 Yahoo Finance 用

import { readFile } from "node:fs/promises";

// 讀取完整的 watchlist.json（含 updatedAt），用來判斷「清單是否有異動」
export async function loadWatchlist() {
  let raw;
  try {
    raw = await readFile("data/watchlist.json", "utf-8");
  } catch {
    console.warn("找不到 data/watchlist.json（可能你的 wealth-ledger 工具還沒同步過），略過。");
    return { updatedAt: null, tickers: [], currencies: [] };
  }
  const json = JSON.parse(raw);
  return {
    updatedAt: json.updatedAt || null,
    tickers: json.tickers || [],
    // 選填：App 同步時可以另外附上「資料庫裡用到的幣別清單」，這樣即使某個外幣只有
    // 現金帳戶、沒有任何該幣別的股票，也會抓到它的匯率。沒有這個欄位時，
    // 就只從 tickers 裡每檔的 currency 推導。
    currencies: json.currencies || [],
  };
}

// 舊有介面：只要 tickers 陣列（保留給還在用這個介面的腳本）
export async function loadTickers() {
  const { tickers } = await loadWatchlist();
  return tickers;
}

// Yahoo Finance 需要台股代碼帶 .TW（上市）或 .TWO（上櫃）後綴，這裡先一律補 .TW，
// 如果你的股票是上櫃股（.TWO），可以直接在 wealth-ledger 的 ticker 欄位輸入時
// 就打完整代碼（例如 "6488.TWO"），這支腳本看到已經有點號就不會再加。
export function toYahooSymbol(item) {
  const t = item.ticker.trim().toUpperCase();
  if (t.includes(".")) return t; // 使用者已經自己打了完整代碼
  if (item.market === "TW" || item.currency === "TWD") return `${t}.TW`;
  return t;
}

// 從 watchlist 整理出「需要抓匯率的外幣」清單（不含 TWD）。
// 來源 1：每檔標的的 currency 欄位；來源 2：watchlist.json 選填的 currencies 陣列。
export function collectForeignCurrencies(watchlist) {
  const found = new Set();
  const addCurrency = (value) => {
    const code = String(value || "").trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && code !== "TWD") found.add(code);
  };
  for (const item of watchlist.tickers || []) addCurrency(item.currency);
  for (const code of watchlist.currencies || []) addCurrency(code);
  return [...found].sort();
}

// 需要保存「歷史匯率」的外幣：「目前持有或曾經交易過」的標的、以及持股趨勢風險報酬分頁的「對標」（benchmark）所用的幣別
// （現值走勢與對標走勢換算台幣都會用到歷史匯率）。
// 只在觀察清單、目標配置出現的標的，以及只在系統設定裡有的幣別，都只保留即時匯率，不存歷史，檔案不會越存越多。
// 舊版 watchlist.json 的標的沒有 sources 欄位時，保守起見視為需要。
export function collectHistoryCurrencies(watchlist) {
  const found = new Set();
  for (const item of watchlist.tickers || []) {
    const code = String(item.currency || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || code === "TWD") continue;
    const sources = item.sources;
    if (!Array.isArray(sources) || sources.includes("traded") || sources.includes("holding") || sources.includes("benchmark")) found.add(code);
  }
  return [...found].sort();
}

// Yahoo Finance 的匯率代碼：USDTWD=X 代表「1 美元 = 多少新台幣」，
// 跟 App 裡「1 外幣 = ? TWD」的匯率方向一致，不需要再取倒數。
export function toYahooFxSymbol(currency) {
  return `${currency}TWD=X`;
}

// 共用的瀏覽器 User-Agent 字串——抓 Yahoo Finance JSON API（YAHOO_HEADERS）
// 跟抓 Yahoo 奇摩股市網頁（fetch-futures-quote.mjs）都需要用到同一個值，
// 集中放在這裡，之後要換 UA 字串只要改一個地方。
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const YAHOO_HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "application/json",
};
