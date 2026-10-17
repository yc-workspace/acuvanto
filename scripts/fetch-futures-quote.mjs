// scripts/fetch-futures-quote.mjs
//
// 抓取 Yahoo 奇摩股市「台指期貨」(WTX&，近月連續) 的成交價與昨收，
// 寫入 data/futures_quote.json，供 wealth-ledger.html 的「期貨」頁使用。
//
// 這條資料管線跟 taifex-margin.yml（抓保證金）、fetch-quotes.yml（抓一般股票報價）
// 是分開的獨立管線：
//   - taifex-margin.yml  -> TAIFEX 官網        -> data/margin.json       （margin/fee，變動不頻繁）
//   - fetch-quotes.yml   -> Yahoo Finance      -> data/quotes.json       （個股，交易時段內）
//   - fetch-futures-quote.yml（本檔）-> Yahoo 奇摩股市 -> data/futures_quote.json（台指期貨點數，全年無休、每分鐘）
//
// 抓取方式參考使用者原本用 Google Sheets IMPORTXML 驗證過可行的兩條 XPath：
//   報價區塊：//*[@id='main-2-FutureChartOverview-Proxy']/div/div[3]/div[2]/ul
//     - 這個 <ul> 裡面依序放著「開盤／買價／賣價／成交／單量／總量／未平倉／漲停／
//       委買筆／委買口／漲幅／最高／最低／漲跌／約高／約低／昨收／跌停／委賣筆／委賣口」
//       這些「中文標籤 + 數字」相連在一起的項目。我們只要「成交」跟「昨收」兩個數字，
//       漲跌／漲跌% 自己算，不用網站上現成的（避免格式或四捨五入方式跟我們自己的不一樣）。
//   時間區塊：//*[@id='main-1-FutureHeader-Proxy']/div[1]/div[2]/div/span
//     - 內容類似「收盤 | 2026/09/02 19:52 更新」，這已經是台北時間，不用再換算時區。
//
// Yahoo 奇摩股市的頁面是伺服器端就把這些文字渲染出來的（IMPORTXML 才抓得到），
// 所以這裡直接用純文字 regex 比對即可，不需要無頭瀏覽器、也不需要額外套件，
// 符合這個專案「零依賴」的原則。若 Yahoo 改版導致抓不到，這支腳本會直接失敗並印出
// 錯誤訊息，GitHub Actions 那次執行會顯示紅色 X，不會靜默寫入錯的資料。

import path from "node:path";
import { BROWSER_USER_AGENT } from "./yahoo-common.mjs";
import { readPrevJson, contentUnchanged, writeJsonFile } from "./json-write-utils.mjs";

const QUOTE_URL = "https://tw.stock.yahoo.com/future/WTX&";
const OUTPUT_PATH = path.join(process.cwd(), "data", "futures_quote.json");

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      "Accept-Language": "zh-TW,zh;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

// 從完整 HTML 裡，取出某個 id 開始往後一段（預設 12000 字），縮小搜尋範圍，
// 避免「成交」「昨收」這種字眼在頁面其他地方（例如別的區塊）被誤抓。
// 抓不到這個 id 的話回傳 null，呼叫端會再退回用整份 HTML 搜尋。
function sliceAfterId(html, id, span = 12000) {
  const idx = html.indexOf(`id="${id}"`);
  if (idx === -1) return null;
  return html.slice(idx, idx + span);
}

// 把 HTML 標籤拿掉、只留文字，並把多個空白／換行壓成一個空白，
// 這樣「成交」跟數字之間即使中間隔著 <span> 之類的標籤，轉成純文字後還是會連在一起
// （對照使用者貼的 IMPORTXML 結果，就是「成交45,960.00」這種黏在一起的樣子）。
function toPlainText(htmlChunk) {
  return htmlChunk
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractPriceAndPrevClose(html) {
  const scoped =
    sliceAfterId(html, "main-2-FutureChartOverview-Proxy") ?? html;
  const text = toPlainText(scoped);

  const priceMatch = text.match(/成交\s*([\d,]+(?:\.\d+)?)/);
  const prevCloseMatch = text.match(/昨收\s*([\d,]+(?:\.\d+)?)/);

  return {
    price: parseNumber(priceMatch?.[1]),
    prevClose: parseNumber(prevCloseMatch?.[1]),
  };
}

// 抓「yyyy/mm/dd hh:mm 更新」這種格式的時間文字，轉成我們工具內統一使用的
// "yyyy-mm-dd hh:mm:ss" 格式（沒有秒數資訊，補 00）。這段文字本身就是台北時間，
// 不需要再做任何時區換算。
function extractUpdatedAt(html) {
  const scoped = sliceAfterId(html, "main-1-FutureHeader-Proxy") ?? html;
  const text = toPlainText(scoped);
  const m = text.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*更新/);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, min] = m;
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

async function main() {
  const html = await fetchHtml(QUOTE_URL);
  const { price, prevClose } = extractPriceAndPrevClose(html);
  const scrapedUpdatedAt = extractUpdatedAt(html);

  if (price == null || prevClose == null) {
    console.error(
      "抓不到「成交」或「昨收」，可能是 Yahoo 頁面結構改版了，需要更新 fetch-futures-quote.mjs 的解析邏輯。"
    );
    process.exit(1);
  }

  const change = Math.round((price - prevClose) * 100) / 100;
  const changePercent =
    prevClose !== 0 ? Math.round((change / prevClose) * 10000) / 100 : null;

  const prevPayload = await readPrevJson(OUTPUT_PATH);
  const draftPayload = {
    symbol: "WTX",
    price,
    prevClose,
    change,
    changePercent,
    updatedAt: null,
  };

  // 內容（成交價／昨收／漲跌／漲跌%）跟上一次完全一樣：代表這次抓到的其實
  // 跟上次沒兩樣（可能是 Yahoo 那頁還沒換下一筆報價，或剛好連兩次成交價
  // 相同）。這種情況沿用舊的 updatedAt，不去蓋新的——不管這次有沒有成功
  // 抓到「yyyy/mm/dd hh:mm 更新」這段文字都一樣，避免「內容明明沒變，只因為
  // 退回用現在時間當 updatedAt」而產生不必要的 commit。
  const unchanged = contentUnchanged(draftPayload, prevPayload);
  const payload = {
    ...draftPayload,
    // 內容有變化才需要決定新的 updatedAt：優先用網站上抓到的
    // 「收盤/一般 | yyyy/mm/dd hh:mm 更新」時間；抓不到的話才退回用這次程式
    // 執行的當下時間（會跟畫面上的台北時間對不太準，但至少不會讓整支腳本失敗）。
    updatedAt: unchanged ? prevPayload.updatedAt : scrapedUpdatedAt ?? taipeiNowString(),
  };

  await writeJsonFile(OUTPUT_PATH, payload);
  console.log(
    unchanged
      ? "台指期貨報價跟上一次完全相同，沿用原本的 updatedAt。"
      : "台指期貨報價有變化，已寫入 data/futures_quote.json：",
    payload
  );
}

function taipeiNowString() {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute"
  )}:${get("second")}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
