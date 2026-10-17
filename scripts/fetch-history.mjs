// 抓取每一檔股票從 1900 年至今的完整日K線，存成 data/history/{ticker}.json
// 給觀察清單的走勢圖、技術指標（MA/RSI 等）在瀏覽器端計算用
// 這支腳本一天跑一次就好，歷史資料不需要頻繁更新
// 註：大部分標的實際掛牌日期都晚於 1900 年，Yahoo 會自動從該標的最早有資料的那天開始回傳，
// 用 1900 當起點只是確保「不管什麼標的都盡量抓到最早的資料」，不用每檔手動判斷上市日。

import { writeFile, mkdir } from "node:fs/promises";
import {
  loadWatchlist,
  toYahooSymbol,
  collectHistoryCurrencies,
  toYahooFxSymbol,
  YAHOO_HEADERS,
} from "./yahoo-common.mjs";

const PERIOD1 = Math.floor(Date.UTC(1900, 0, 1) / 1000);

// 日期基準：
// - 股票：每根日K存「該交易所當地的交易日」。Yahoo 的日K時間戳記是該市場的開盤時間，這裡用 Yahoo 在 meta 回報的
//   gmtoffset（交易所時區與 UTC 的秒差）換算成當地日期；台股就是台北日期，美股是美東日期（比台北晚半天到一天），
//   澳股等比 UTC 早很多的市場，直接取 UTC 日期會差一天，所以不能用 UTC。
// - 匯率（isFx = true）：日K時間戳記可能落在前一天的 23:00 UTC（倫敦午夜），所以加 12 小時再取 UTC 日期，
//   不管落在 00:00 或前一天 23:00 都歸到正確的那天；只保留日期與收盤價，檔案小很多。
// 工具裡使用者輸入的日期是台北時間，跟這裡的「交易所當地交易日」不一定同一天，換算與提示由 App 端處理。
async function fetchHistory(symbol, { isFx = false } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const eventsParam = isFx ? "" : "&events=div%2Csplits";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?period1=${PERIOD1}&period2=${period2}&interval=1d${eventsParam}`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo 回傳沒有資料");

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const gmtoffsetRaw = Number(result.meta?.gmtoffset);
  const hasGmtoffset = Number.isFinite(gmtoffsetRaw);
  const offsetSeconds = isFx ? 12 * 3600 : hasGmtoffset ? gmtoffsetRaw : 0;
  const toDateText = (ts) => new Date((ts + offsetSeconds) * 1000).toISOString().slice(0, 10);
  const rows = timestamps.map((ts, i) =>
    isFx
      ? { date: toDateText(ts), close: q.close?.[i] ?? null }
      : {
          date: toDateText(ts),
          open: q.open?.[i] ?? null,
          high: q.high?.[i] ?? null,
          low: q.low?.[i] ?? null,
          close: q.close?.[i] ?? null,
          volume: q.volume?.[i] ?? null,
        }
  );

  // 分割事件：Yahoo 的 numerator 是「分割後的股數」、denominator 是「分割前的股數」
  // （7 比 1 分割 → numerator 7、denominator 1、ratio 7）。這裡只是「記錄」Yahoo 回報了什麼，
  // 不代表歷史收盤價已經還原——有些標的（例如台股 0052）Yahoo 回報了分割事件，
  // 但歷史收盤價仍是分割前的原值，App 端要拿分割日前後的收盤價比對，才能判斷要不要還原。
  const splits = Object.values(result.events?.splits || {})
    .map((event) => ({
      date: toDateText(event.date),
      numerator: Number(event.numerator),
      denominator: Number(event.denominator),
    }))
    .filter((event) => event.numerator > 0 && event.denominator > 0)
    .map((event) => ({ ...event, ratio: event.numerator / event.denominator }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 濾掉停牌造成的空值列
  return {
    rows: rows.filter((r) => r.close != null),
    splits,
    exchangeTimezone: result.meta?.exchangeTimezoneName || null,
    gmtoffset: hasGmtoffset ? gmtoffsetRaw : null,
  };
}

// 檔名不能有奇怪字元，把 ticker 轉成安全檔名（. 和大部分符號其實檔名系統都能接受，
// 這裡只是保守起見換成底線，避免少數雲端同步服務對某些符號挑剔）
function safeFileName(ticker) {
  return ticker.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
}

async function main() {
  const watchlist = await loadWatchlist();
  const tickers = watchlist.tickers;
  await mkdir("data/history", { recursive: true });

  if (!tickers.length) {
    console.log("watchlist 是空的（data/watchlist.json 還不存在，或裡面沒有任何 ticker），先放一個佔位檔案，讓這個資料夾能被 git 追蹤。");
    await writeFile(
      "data/history/.gitkeep",
      "# 這個檔案只是為了讓空資料夾能被 git 記錄，尚無 ticker 時會只有這個檔案。\n" +
        "# 之後在 wealth-ledger 裡新增觀察清單或持股交易後，重新跑一次這個 Action 就會產生真正的歷史資料。\n",
      "utf-8"
    );
    return;
  }

  for (const item of tickers) {
    const symbol = toYahooSymbol(item);
    try {
      console.log(`抓取歷史K線中：${item.ticker} → Yahoo symbol ${symbol}`);
      const { rows, splits, exchangeTimezone, gmtoffset } = await fetchHistory(symbol);
      const out = {
        ticker: item.ticker,
        yahooSymbol: symbol,
        updatedAt: new Date().toISOString(),
        // 日期基準：rows 與 splits 的日期是這個交易所時區的當地交易日（見 fetchHistory 上方說明）
        exchangeTimezone,
        gmtoffset,
        splits,
        rows,
      };
      await writeFile(
        `data/history/${safeFileName(item.ticker)}`,
        JSON.stringify(out, null, 2),
        "utf-8"
      );
      console.log(`  → 已存檔，共 ${rows.length} 筆日K`);
    } catch (err) {
      console.error(`  ✗ 失敗：${item.ticker}：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // 外幣歷史匯率：只存「有持有或交易過的標的」用到的幣別（見 collectHistoryCurrencies），
  // 其他幣別只在 quotes.json 保留即時匯率。存成 data/history/fx/{幣別}.json，每天由排程自動更新，
  // 不需要使用者開工具。App 的歷史現值走勢用這份資料換算外幣標的，即時匯率則取自
  // quotes.json 的 fxRates，兩邊都是 Yahoo 的同一組匯率代碼。
  await mkdir("data/history/fx", { recursive: true });
  for (const currency of collectHistoryCurrencies(watchlist)) {
    const symbol = toYahooFxSymbol(currency);
    try {
      console.log(`抓取歷史匯率中：${currency}/TWD → Yahoo symbol ${symbol}`);
      const { rows } = await fetchHistory(symbol, { isFx: true });
      const out = {
        currency,
        yahooSymbol: symbol,
        updatedAt: new Date().toISOString(),
        rows,
      };
      await writeFile(
        `data/history/fx/${currency}.json`,
        JSON.stringify(out, null, 2),
        "utf-8"
      );
      console.log(`  → 已存檔，共 ${rows.length} 筆日匯率`);
    } catch (err) {
      console.error(`  ✗ 失敗：${currency} 歷史匯率：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
