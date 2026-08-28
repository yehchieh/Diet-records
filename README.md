[README.md](https://github.com/user-attachments/files/31555245/README.md)
# 飲食日誌 · 三餐紀錄表單

一頁式的三餐紀錄表單。開著就能填，資料存在瀏覽器本機，需要時才推到 GitHub，再由 GitHub Actions 寫進 Notion 資料庫。

```
index.html  ──填寫──▶  瀏覽器本機儲存
     │
     └──推送──▶  GitHub repo  ──Actions──▶  Notion 資料庫
```

---

## 1. 放上 GitHub Pages

```bash
git init
git add index.html
git commit -m "飲食日誌"
git branch -M main
git remote add origin https://github.com/<你的帳號>/diet-log.git
git push -u origin main
```

到 repo 的 **Settings → Pages**，Source 選 `main` / `root`。
幾十秒後就能在 `https://<你的帳號>.github.io/diet-log/` 開啟，手機加到主畫面當 App 用。

建議把 repo 設成 **Private**，Pages 需要付費方案才支援私有；不想付費就用 Public repo，但**不要**把權杖寫進程式碼（表單裡填的權杖只留在你的裝置上，不會進 commit）。

---

## 2. 表單直接 commit 進 repo

展開表單裡的「同步到 GitHub」：

| 欄位 | 填什麼 |
|---|---|
| 儲存庫 | `你的帳號/diet-log` |
| 檔案路徑 | `logs/{{date}}.md`（也可用 `logs/{{yyyy}}/{{mm}}/{{date}}.md`） |
| 分支 | `main` |
| 存取權杖 | 下面產生的 token |

產生權杖：GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**

- Repository access：只選 `diet-log` 這一個
- Permissions → Repository permissions → **Contents: Read and write**
- 其他全部不給，有效期建議設 90 天

按「推送當日紀錄」會寫一個 Markdown 檔；按「推送全部 JSON」會寫 `data/diet-log.json`，這個檔就是給 Notion 同步用的來源。

---

## 3. 建 Notion 資料庫

新開一個 Database，欄位這樣設：

| 屬性名稱 | 型別 |
|---|---|
| 日期 | Title |
| 記錄日 | Date |
| 早餐 | Text |
| 午餐 | Text |
| 晚餐 | Text |
| 點心 | Text |
| 熱量 | Number |
| 額度 | Number |
| 剩餘 | Number |
| 飲水 | Number |
| 體重 | Number |
| 備註 | Text |

然後到 <https://www.notion.so/my-integrations> 建一個 internal integration，複製 **Internal Integration Secret**。
回到資料庫頁面右上角 `⋯` → **Connections** → 加入剛剛那個 integration，否則 API 會回 404。

資料庫 ID 是網址裡 `notion.so/` 後面那串 32 碼英數（`?v=` 之前）。

---

## 4. 設定 GitHub Actions 同步

repo 的 **Settings → Secrets and variables → Actions → New repository secret**，加兩個：

- `NOTION_TOKEN` → integration secret
- `NOTION_DB_ID` → 資料庫 ID

### `.github/workflows/notion-sync.yml`

```yaml
name: 同步飲食紀錄到 Notion

on:
  push:
    paths:
      - 'data/diet-log.json'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: node scripts/sync-notion.mjs
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
          NOTION_DB_ID: ${{ secrets.NOTION_DB_ID }}
```

### `scripts/sync-notion.mjs`

不用裝任何套件，Node 20 內建 fetch。

```js
import { readFile } from 'node:fs/promises';

const TOKEN = process.env.NOTION_TOKEN;
const DB = process.env.NOTION_DB_ID;
const HEAD = {
  'Authorization': `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

const api = async (path, method, body) => {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method, headers: HEAD, body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const text = v => ({ rich_text: [{ text: { content: String(v || '').slice(0, 2000) } }] });
const num  = v => ({ number: v === '' || v == null || isNaN(Number(v)) ? null : Number(v) });

function toProps(date, d) {
  const m = k => (d.meals?.[k]?.items || '');
  const kcal = ['breakfast','lunch','dinner','snack']
    .reduce((a, k) => a + (parseInt(d.meals?.[k]?.kcal, 10) || 0), 0);
  const budget = parseInt(d.budget, 10) || 0;
  return {
    '日期':   { title: [{ text: { content: date } }] },
    '記錄日': { date: { start: date } },
    '早餐':   text(m('breakfast')),
    '午餐':   text(m('lunch')),
    '晚餐':   text(m('dinner')),
    '點心':   text(m('snack')),
    '熱量':   num(kcal || null),
    '額度':   num(budget || null),
    '剩餘':   num(budget ? budget - kcal : null),
    '飲水':   num(d.water),
    '體重':   num(d.weight),
    '備註':   text(d.note)
  };
}

const log = JSON.parse(await readFile('data/diet-log.json', 'utf8'));

for (const [date, entry] of Object.entries(log)) {
  const found = await api('databases/' + DB + '/query', 'POST', {
    filter: { property: '日期', title: { equals: date } }, page_size: 1
  });
  const props = toProps(date, entry);

  if (found.results.length) {
    await api('pages/' + found.results[0].id, 'PATCH', { properties: props });
    console.log('更新', date);
  } else {
    await api('pages', 'POST', { parent: { database_id: DB }, properties: props });
    console.log('新增', date);
  }
  await new Promise(r => setTimeout(r, 350)); // Notion 限流約 3 req/s
}

console.log('完成，共', Object.keys(log).length, '天');
```

推完之後，每次表單按「推送全部 JSON」，Action 就會自動把新的日子寫進 Notion，同一天重推則是更新不會重複。

---

## 不想架 Action 的話

表單裡「複製 Notion 表格」會把當天內容複製成 Markdown 表格，直接貼進 Notion 頁面就會變成表格區塊。手動但零設定。

> Notion API 不能從瀏覽器直接呼叫（他們沒開 CORS），所以中間一定要有一段伺服器或 Action。GitHub 的 API 反而有開，表單才能直接 commit。

---

## 資料存在哪

- 填寫中的資料存在瀏覽器本機（同一個網域、同一台裝置）。換裝置或清快取就沒了，所以要保留就記得推 GitHub。
- 「下載全部 .csv / .json」隨時可以整包帶走。
- GitHub 權杖也只存在本機，不會出現在任何 commit 裡。

---

## 照片

每一餐最多可以加 3 張照片，按卡片下方的虛線「＋ 照片」，手機會問要拍照還是從相簿選。存進去之前會先縮到長邊 1000px、轉成 JPEG，一張大約 100KB 上下。點縮圖可以放大看，右上角 ✕ 刪掉。

照片先存在瀏覽器本機，容量有限（大約幾 MB），所以**照片要長期留著就要推去 GitHub**。按「推送當日紀錄」時會：

1. 把當天的照片上傳到 `photos/<日期>/<餐別>-<編號>.jpg`
2. 產生的 Markdown 自動附上圖片連結

`https://raw.githubusercontent.com/<帳號>/<repo>/<分支>/photos/...`

要讓 Notion 也看得到圖，repo 必須是 **Public**（raw 連結對私有 repo 需要授權，Notion 讀不到）。想留私有的話，照片就只在 GitHub 上看，Notion 那邊維持純文字。

想把圖也塞進 Notion 頁面，在 `sync-notion.mjs` 的 `api('pages', ...)` 呼叫裡多帶一個 `children`：

```js
children: (d.photos || []).map(url => ({
  object: 'block',
  type: 'image',
  image: { type: 'external', external: { url } }
}))
```
