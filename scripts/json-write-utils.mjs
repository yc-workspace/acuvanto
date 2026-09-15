// scripts/json-write-utils.mjs
//
// 給 fetch-quotes.mjs / fetch-margin.mjs / fetch-futures-quote.mjs 共用的小工具。
//
// 背景：這幾支腳本每次執行都會在輸出的 JSON 最前面放一個 updatedAt 時間戳記。
// 如果不管背後實際抓到的資料有沒有變化、每次都無條件蓋成「現在」，即使
// 報價／保證金金額根本沒變，這個檔案也會被 git 判定成「有變化」而產生一次 commit。
// 這個 repo 同時有好幾支每分鐘／每天固定觸發的 workflow 在對同一個 main 分支
// 做這件事，commit 越密集，git push 時彼此撞在一起（尤其是撞在 updatedAt
// 這一行）的機率就越高。
//
// 解法：寫檔前先讀「上一次寫入的內容」，把 updatedAt 這個欄位拿掉之後跟這次
// 準備要寫的內容做深度比較。如果完全一樣，代表「這次抓到的其實跟上次沒兩樣」，
// 就沿用舊的 updatedAt、不去動它；只有真的有變化（或是第一次執行、上次的檔案
// 讀不到／壞掉）才蓋上新的時間戳記。這樣 git diff 才會如實反映「這次真的沒有
// 變化」，workflow 裡「沒有變化就不 commit」的判斷才會真的生效。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// 遞迴深度比較兩個值是否內容完全相同，不管物件裡 key 的先後順序
// （JSON.stringify 兩個 key 順序不同但內容相同的物件會被誤判成不同，
// 所以這裡不能只靠字串比對，要真的遞迴比較）。
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
}

// 讀取上一次寫入的 JSON 檔案。檔案不存在、或內容不是合法 JSON（例如第一次
// 執行、或檔案曾經寫壞），一律當作「沒有上一次」，回傳 null，不讓呼叫端
// 需要自己處理 try/catch。
export async function readPrevJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// 比較「這次準備寫入的內容」跟「上一次寫入的內容」，扣掉 updatedAt 這個欄位
// 之後是否完全相同。上一次讀不到（null）一律視為「不同」（因為根本沒有
// 基準可以比，且這種情況通常代表第一次執行，本來就應該蓋上新時間戳記）。
//
// 這裡刻意先對兩邊都做一次 JSON.parse(JSON.stringify(...))：draft 物件如果
// 有欄位的值是 undefined（例如「沒有任何抓取錯誤時」的 fetchErrors: undefined），
// 在 JS 裡 Object.keys() 還是會算進這個 key，但 JSON.stringify 實際寫檔時會
// 把它拿掉——如果不先正規化，直接比較會出現「draft 有這個 key（值是
// undefined）、上次讀回來的舊檔案沒有這個 key」的假差異，把「其實沒變化」
// 誤判成「有變化」。先用 JSON round-trip 讓兩邊都變成「真正會被寫進檔案的
// 樣子」再比對，就能避免這個誤判。
export function contentUnchanged(draft, prev, updatedAtKey = "updatedAt") {
  if (prev == null || typeof prev !== "object") return false;
  const normalize = (obj) => {
    const copy = { ...obj };
    delete copy[updatedAtKey];
    return JSON.parse(JSON.stringify(copy));
  };
  return deepEqual(normalize(draft), normalize(prev));
}

// 寫檔本身：固定用 2 個空白縮排＋結尾補一個換行，跟這幾支腳本原本的寫法一致。
export async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}
