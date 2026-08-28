import { readFile } from 'node:fs/promises';

const TOKEN = process.env.NOTION_TOKEN;
const DB = process.env.NOTION_DB_ID;

// ── 先把設定問題講清楚，不要等到 API 回一個看不懂的錯 ──
if (!TOKEN) { console.error('✗ 找不到 NOTION_TOKEN，去 repo 的 Settings → Secrets and variables → Actions 加上'); process.exit(1); }
if (!DB)    { console.error('✗ 找不到 NOTION_DB_ID，同上'); process.exit(1); }
if (!/^ntn_|^secret_/.test(TOKEN)) console.warn('! 金鑰格式看起來不對，正常是 ntn_ 開頭');

const HEAD = {
  'Authorization': `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

async function api(path, method, body) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method, headers: HEAD, body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new Error('金鑰無效或過期，重新產生一次 NOTION_TOKEN');
    if (res.status === 404) throw new Error('找不到資料庫。多半是沒把 integration 加進資料庫的 Connections，或 NOTION_DB_ID 填錯');
    if (res.status === 400 && text.includes('is not a property')) {
      throw new Error('欄位名稱對不上。Notion 資料庫的欄位必須是：日期 記錄日 早餐 午餐 晚餐 點心 熱量 額度 剩餘 飲水 體重 備註\n原始訊息：' + text);
    }
    throw new Error(`${method} ${path} → ${res.status}\n${text}`);
  }
  return JSON.parse(text);
}

const text = v => ({ rich_text: [{ text: { content: String(v || '').slice(0, 2000) } }] });
const num  = v => ({ number: v === '' || v == null || isNaN(Number(v)) ? null : Number(v) });

function toProps(date, d) {
  const m = k => (d.meals?.[k]?.items || '');
  const kcal = ['breakfast', 'lunch', 'dinner', 'snack']
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

let log;
try {
  log = JSON.parse(await readFile('data/diet-log.json', 'utf8'));
} catch (e) {
  console.error('✗ 讀不到 data/diet-log.json。先在表單按「推送全部 JSON」把資料推上來');
  process.exit(1);
}

const dates = Object.keys(log).sort();
console.log(`讀到 ${dates.length} 天的紀錄：${dates[0]} ~ ${dates[dates.length - 1]}`);

let added = 0, updated = 0;

for (const date of dates) {
  const found = await api(`databases/${DB}/query`, 'POST', {
    filter: { property: '日期', title: { equals: date } }, page_size: 1
  });
  const properties = toProps(date, log[date]);

  if (found.results.length) {
    await api(`pages/${found.results[0].id}`, 'PATCH', { properties });
    console.log(`  更新 ${date}`);
    updated++;
  } else {
    await api('pages', 'POST', { parent: { database_id: DB }, properties });
    console.log(`  新增 ${date}`);
    added++;
  }
  await new Promise(r => setTimeout(r, 350)); // Notion 限流約 3 req/s
}

console.log(`\n✓ 完成：新增 ${added} 筆、更新 ${updated} 筆`);
