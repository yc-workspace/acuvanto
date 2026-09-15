// 抓取 TAIFEX OpenAPI 的保證金資料，存成 raw 備份 + 給網頁工具用的 data/margin.json
// 執行環境：GitHub Actions 的 ubuntu-latest + Node 24（內建 fetch，不需要額外安裝套件）
//
// 2026-08-27 更新：用你實際跑出來的完整資料校正過欄位對應。
//
// 股價指數類（IndexFuturesAndOptionsMargining）長這樣：
//   {"Contract":"臺股期貨","ClearingMargin":"519000","MaintenanceMargin":"538000","InitialMargin":"701000","Date":"20260826"}
// 這個檔案裡總共有 32 種合約（大台/小台/微台/電子/金融/道瓊/標普/那斯達克...等），
// 全部都用同一套欄位，所以這裡改成把「全部」都存進 indexDetail，用合約的
// 中文全名當 key。之後想在 App 裡加新的期貨商品，不用再改這支腳本，
// 直接從 indexDetail 用正確的中文名稱去查就好。
//
// 這裡要特別小心一個陷阱：「小型臺指」跟「客製化小型臺指期貨」是两個不同的
// 合約，但字串上「客製化小型臺指期貨」也包含「小型」「臺指」這幾個字，
// 如果用「包含」比對會誤判。所以下面改成用「完全相等」比對合約全名，
// 不再用模糊比對。

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readPrevJson, contentUnchanged, writeJsonFile } from "./json-write-utils.mjs";

const BASE = "https://openapi.taifex.com.tw/v1";

const ENDPOINTS = {
  IndexFuturesAndOptionsMargining: "保證金一覽表-股價指數類",
  InterestRateFuturesMargining: "保證金一覽表-利率類",
  GoldFuturesAndOptionsMargining: "保證金一覽表-商品類",
  SingleStockFuturesMargining: "保證金一覽表-股票類",
  SingleStockFuturesETFMargining: "保證金一覽表-股票類(ETF)",
};

// -----------------------------------------------------------------------
// 手續費：TAIFEX 公開 API 不會有你券商實際收的手續費，這裡先放你截圖裡對得上
// 的預設值，改成你自己的數字後 commit 上去即可。
// -----------------------------------------------------------------------
const MANUAL_FEE = {
  TX: 45,
  MTX: 30,
  TMF: 20,
};

// wealth-ledger App 目前的期貨分頁固定認得這三個代碼，對照到 TAIFEX
// 官方合約全名（用「完全相等」比對，避免跟客製化合約搞混）。
// 之後想讓 App 支援更多商品（電子期貨、金融期貨...），
// 在這裡多加一行對照，例如：TE: "電子期貨", MTE: "小型電子期貨"
const CODE_TO_CONTRACT_NAME = {
  TX: "臺股期貨",
  MTX: "小型臺指",
  TMF: "微型臺指期貨",
};

function toNumber(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toPercent(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/%/g, "").trim());
  return Number.isFinite(n) ? n / 100 : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// 股價指數類：存成「合約全名 → 保證金明細」的完整對照表，不只留 TX/MTX/TMF，
// 這樣以後不管 TAIFEX 出什麼新指數期貨都已經在裡面了
function normalizeIndexMargining(rows) {
  const byName = {};
  if (!Array.isArray(rows)) return byName;
  for (const row of rows) {
    const name = String(row.Contract || "").trim();
    if (!name) continue;
    byName[name] = {
      initialMargin: toNumber(row.InitialMargin),
      maintenanceMargin: toNumber(row.MaintenanceMargin),
      clearingMargin: toNumber(row.ClearingMargin),
      date: row.Date || null,
    };
  }
  return byName;
}

// 利率類、商品類（黃金/原油）：Contract 本身就是代碼或簡短中文名，
// 原樣存成陣列，之後要用再依 Contract 篩選
function normalizeSimpleMargining(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    contract: row.Contract || null,
    initialMargin: toNumber(row.InitialMargin),
    maintenanceMargin: toNumber(row.MaintenanceMargin),
    clearingMargin: toNumber(row.ClearingMargin),
    date: row.Date || null,
  }));
}

// 股票期貨：用「保證金成數」而不是固定金額（20.25% 這種百分比）
function normalizeStockMargining(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    contract: row.Contract || null,
    underlyingSecurityCode: row.UnderlyingSecurityCode || null,
    contractName: row.ContractName || null,
    underlyingName: row.UnderlyingOfSingleStockFutures || null,
    groupLevel: row.GroupLevel || null,
    initialMarginRate: toPercent(row.InitialMarginRate),
    maintenanceMarginRate: toPercent(row.MaintenanceMarginRate),
    clearingMarginRate: toPercent(row.ClearingMarginRate),
    date: row.Date || null,
  }));
}

// 股票期貨(ETF)：跟一般股票期貨不同，是固定金額不是成數
function normalizeStockETFMargining(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    contract: row.Contract || null,
    underlyingSecurityCode: row.UnderlyingSecurityCode || null,
    contractName: row.ContractName || null,
    underlyingName: row.UnderlyingOfSingleStockFutures || null,
    initialMargin: toNumber(row.InitialMargin),
    maintenanceMargin: toNumber(row.MaintenanceMargin),
    clearingMargin: toNumber(row.ClearingMargin),
    date: row.Date || null,
  }));
}

async function main() {
  const outDir = path.resolve("data");
  const rawDir = path.join(outDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const results = {};
  const errors = {};

  for (const name of Object.keys(ENDPOINTS)) {
    const url = `${BASE}/${name}`;
    try {
      console.log(`抓取中：${name} (${url})`);
      const json = await fetchJson(url);
      results[name] = json;
      await writeFile(path.join(rawDir, `${name}.json`), JSON.stringify(json, null, 2), "utf-8");
      const sample = Array.isArray(json) ? json[0] : json;
      console.log(`  → 已存檔，共 ${Array.isArray(json) ? json.length : 1} 筆，範例第一筆：`, JSON.stringify(sample));
    } catch (err) {
      console.error(`  ✗ 抓取失敗：${name}：${err.message}`);
      errors[name] = String(err.message || err);
    }
  }

  const indexDetail = normalizeIndexMargining(results.IndexFuturesAndOptionsMargining);

  // margin / maintenanceMargin：給 wealth-ledger 期貨分頁直接用的扁平結構（TX / MTX / TMF）
  const margin = {};
  const maintenanceMargin = {};
  for (const [code, contractName] of Object.entries(CODE_TO_CONTRACT_NAME)) {
    const info = indexDetail[contractName];
    if (!info) {
      console.warn(`⚠️ 找不到合約「${contractName}」（代碼 ${code}），請確認 TAIFEX 是否改了名稱。`);
      continue;
    }
    if (info.initialMargin != null) margin[code] = info.initialMargin;
    if (info.maintenanceMargin != null) maintenanceMargin[code] = info.maintenanceMargin;
  }

  const marginPath = path.join(outDir, "margin.json");
  const prevMarginJson = await readPrevJson(marginPath);

  const draftMarginJson = {
    // updatedAt 先留一個佔位值，下面比對完內容有沒有變之後才決定要不要蓋新的，
    // 這裡的值本身不重要（contentUnchanged 比對時一律會先把這個欄位拿掉）。
    updatedAt: null,
    source: "TAIFEX OpenAPI",
    // 目前 App 期貨分頁在用的欄位（股價指數類：大台 TX / 小台 MTX / 微台 TMF）
    margin,
    maintenanceMargin,
    fee: MANUAL_FEE,
    // 股價指數類全部 32 種合約的完整明細，用合約中文全名當 key。
    // 之後想加新商品，直接從這裡查，例如 indexDetail["電子期貨"].initialMargin
    indexDetail,
    // 其餘 4 類先原樣存起來，保留未來擴充其他期貨商品的彈性
    categories: {
      interestRate: normalizeSimpleMargining(results.InterestRateFuturesMargining),
      gold: normalizeSimpleMargining(results.GoldFuturesAndOptionsMargining),
      singleStock: normalizeStockMargining(results.SingleStockFuturesMargining),
      singleStockETF: normalizeStockETFMargining(results.SingleStockFuturesETFMargining),
    },
    fetchErrors: Object.keys(errors).length ? errors : undefined,
  };

  // 內容（扣掉 updatedAt）跟上一次完全一樣：代表這次抓到的保證金資料其實
  // 沒有變化，沿用舊的 updatedAt、原封不動寫回跟上次一樣的內容，這樣 git
  // 才會如實判定「這個檔案這次沒有變化」，workflow 就會跳過這次 commit。
  const unchanged = contentUnchanged(draftMarginJson, prevMarginJson);
  const marginJson = {
    ...draftMarginJson,
    updatedAt: unchanged ? prevMarginJson.updatedAt : new Date().toISOString(),
  };

  await writeJsonFile(marginPath, marginJson);

  console.log("---");
  if (unchanged) {
    console.log("保證金內容跟上一次抓到的完全相同，沿用原本的 updatedAt，不產生新的變化。");
  } else {
    console.log("保證金內容跟上一次不同（或這是第一次執行），已蓋上新的 updatedAt。");
  }
  console.log("已產生 data/margin.json，股價指數類（TX/MTX/TMF）比對結果：", JSON.stringify({ margin, maintenanceMargin }, null, 2));

  if (Object.keys(margin).length === 0) {
    console.warn("⚠️ 沒有成功比對到任何 TX / MTX / TMF 的保證金數字，請把上面「範例第一筆資料」的完整內容貼給 Claude。");
  } else {
    console.log(`✓ 成功比對到 ${Object.keys(margin).length} / 3 檔股價指數類期貨的保證金。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
