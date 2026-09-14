// 抓取 data/watchlist.json 裡每一檔股票的最新報價，寫成 data/quotes.json
// 給 wealth-ledger 網頁工具的「投資總覽」「觀察清單」讀取
//
// 排程本身（.github/workflows/fetch-quotes.yml）設定成每分鐘觸發一次，全年無休、
// 不分市場交易時段，每次觸發都會直接抓取（不再做「是否在交易時段內」的判斷——
// 這支工具支援 BTC 等全年無休的標的，時段限制在 2026 年已經拿掉了）。
// FORCE_FETCH / listChanged 只影響 log 訊息內容，不影響「要不要抓」。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadWatchlist, toYahooSymbol, YAHOO_HEADERS } from "./yahoo-common.mjs";

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo 回傳沒有資料（代碼可能打錯或已下市）");

  const meta = result.meta || {};
  const price = meta.regularMarketPrice ?? null;

  // 不要相信 meta.previousClose / meta.chartPreviousClose：用 range=5d 這種「範圍」
  // 參數請求時，Yahoo 常常沒回傳 previousClose，退回用的 chartPreviousClose 實際上
  // 等於「這次回傳範圍裡最舊一根 K 棒」的收盤價，不是真正的前一交易日收盤——範圍
  // 內實際涵蓋幾個交易日又會因為假日、週末浮動，遇到連假時差距可以拉到一整週。
  // 改成直接從日K收盤價陣列本身取值：陣列最後一筆永遠對應「當前這個交易日」
  // （不管現在是盤中即時價、已收盤，還是假日沿用最後一次收盤），倒數第二筆就是
  // 真正的前一交易日收盤，這個相對位置不受 API 實際回傳幾天影響，跟
  // fetch-history.mjs 本來就在用、且已驗證過沒問題的做法一致。
  const closes = result.indicators?.quote?.[0]?.close || [];
  const validCloses = closes.filter((c) => c != null);
  const prevClose =
    validCloses.length >= 2
      ? validCloses[validCloses.length - 2]
      : meta.previousClose ?? meta.chartPreviousClose ?? null; // 保底：只有一天資料時才退回原本邏輯

  const volumes = result.indicators?.quote?.[0]?.volume || [];
  const lastVolume = [...volumes].reverse().find((v) => v != null) ?? null;

  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct =
    change != null && prevClose ? (change / prevClose) * 100 : null;

  return {
    price,
    prevClose,
    change,
    changePct,
    volume: lastVolume,
    currency: meta.currency || null,
    exchangeName: meta.exchangeName || null,
    asOf: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : null,
  };
}

// 讀取上一次寫出的 data/quotes.json，用來比對 watchlist 的 updatedAt 有沒有變過
async function readPrevQuotes() {
  try {
    const raw = await readFile("data/quotes.json", "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 寫一行給 GitHub Actions 的 workflow 讀（是否要順便觸發歷史K線補抓）
async function setGithubOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return; // 本機手動測試時可能沒有這個環境變數，直接略過即可
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, `${name}=${value}\n`, "utf-8");
}

async function main() {
  const force = process.env.FORCE_FETCH === "true" || process.env.FORCE_FETCH === "1";
  const watchlist = await loadWatchlist();
  const tickers = watchlist.tickers;

  const prevQuotes = await readPrevQuotes();
  const listChanged =
    watchlist.updatedAt != null &&
    watchlist.updatedAt !== prevQuotes?.sourceWatchlistUpdatedAt;

  console.log(
    force
      ? "手動強制抓取（FORCE_FETCH=true）。"
      : listChanged
      ? "偵測到 data/watchlist.json 有異動（清單新增/修改/刪除了 ticker），這次一併補抓。"
      : "每分鐘例行抓取（全年無休、不分市場時段）。"
  );

  await mkdir("data", { recursive: true });

  if (!tickers.length) {
    console.log("watchlist 是空的（data/watchlist.json 還不存在，或裡面沒有任何 ticker），先寫一個空的 data/quotes.json 佔位。");
    await writeFile(
      "data/quotes.json",
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          sourceWatchlistUpdatedAt: watchlist.updatedAt,
          quotes: {},
          note: "尚無 ticker，請先在 wealth-ledger 裡新增觀察清單或持股交易",
        },
        null,
        2
      ),
      "utf-8"
    );
    await setGithubOutput("list_changed", String(listChanged));
    return;
  }

  const quotes = {};
  const errors = {};

  for (const item of tickers) {
    const symbol = toYahooSymbol(item);
    try {
      console.log(`抓取報價中：${item.ticker} → Yahoo symbol ${symbol}`);
      quotes[item.ticker] = { ...(await fetchQuote(symbol)), yahooSymbol: symbol };
    } catch (err) {
      console.error(`  ✗ 失敗：${item.ticker}：${err.message}`);
      errors[item.ticker] = String(err.message || err);
    }
    // 稍微間隔一下，避免短時間內對 Yahoo 打太多請求被限流
    await new Promise((r) => setTimeout(r, 300));
  }

  await mkdir("data", { recursive: true });
  const out = {
    updatedAt: new Date().toISOString(),
    sourceWatchlistUpdatedAt: watchlist.updatedAt,
    quotes,
    fetchErrors: Object.keys(errors).length ? errors : undefined,
  };
  await writeFile("data/quotes.json", JSON.stringify(out, null, 2), "utf-8");
  console.log(`已寫入 data/quotes.json，共 ${Object.keys(quotes).length} 檔成功。`);
  await setGithubOutput("list_changed", String(listChanged));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
