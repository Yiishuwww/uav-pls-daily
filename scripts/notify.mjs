import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_PATH = path.join(ROOT, "site", "data.js");
const PREVIEW_PATH = path.join(ROOT, "notification-preview.md");
const siteUrl = (process.env.SITE_URL || "https://example.com").replace(/\/$/, "");
const timezone = process.env.SITE_TIMEZONE || "Asia/Shanghai";

const data = await loadData();
const today = dateInTimezone(new Date(), timezone);
const newPapers = data.papers.filter((paper) => paper.firstSeenDate === today);
const candidates = newPapers.length
  ? newPapers
  : data.papers
      .filter((paper) => daysBetween(paper.firstSeenDate, today) <= 7)
      .sort((a, b) => b.score - a.score || String(b.publishedAt).localeCompare(String(a.publishedAt)));

const picks = [...candidates]
  .sort((a, b) => b.score - a.score || String(b.publishedAt).localeCompare(String(a.publishedAt)))
  .slice(0, 5);

const message = buildMessage(picks, newPapers.length, today, siteUrl);
await writeFile(PREVIEW_PATH, message.markdown, "utf8");
console.log(`[notify] Preview written to ${PREVIEW_PATH}`);

let delivered = 0;
if (process.env.WECOM_WEBHOOK_URL) {
  await sendWeCom(process.env.WECOM_WEBHOOK_URL, message.wecom);
  delivered += 1;
}
if (process.env.PUSHPLUS_TOKEN) {
  await sendPushPlus(process.env.PUSHPLUS_TOKEN, message.title, message.markdown);
  delivered += 1;
}
if (process.env.SERVERCHAN_SENDKEY) {
  await sendServerChan(process.env.SERVERCHAN_SENDKEY, message.title, message.markdown);
  delivered += 1;
}

if (!delivered) {
  console.log("[notify] No push credentials configured; preview only.");
} else {
  console.log(`[notify] Delivered through ${delivered} channel(s).`);
}

async function loadData() {
  const text = await readFile(DATA_PATH, "utf8");
  const match = text.match(/window\.UAV_PLS_DATA\s*=\s*([\s\S]*);\s*$/);
  if (!match) throw new Error("Could not parse site/data.js");
  return JSON.parse(match[1]);
}

function buildMessage(papers, dailyCount, day, url) {
  const title = `UAV 物理层安全日报 · ${day}`;
  const countLine = dailyCount
    ? `今日新增 ${dailyCount} 篇，以下为相关度前 ${papers.length} 篇：`
    : `今日暂无新增记录；以下为近期高相关论文：`;

  const body = papers.length
    ? papers.map((paper, index) => {
        const kind = paper.isPreprint ? "预印本" : "正式发表";
        return `${index + 1}. [${trim(paper.title, 160)}](${paper.url})\n   ${kind} · ${paper.venue || paper.source || "学术来源"} · 相关度 ${Number(paper.score).toFixed(1)}`;
      }).join("\n\n")
    : "今天没有通过相关性闸门的新论文。";

  const markdown = `# ${title}\n\n${countLine}\n\n${body}\n\n[查看完整日报与筛选](${url})`;
  const wecom = [
    `## ${title}`,
    `> ${countLine}`,
    ...papers.map((paper, index) => `${index + 1}. [${trim(paper.title, 90)}](${paper.url})\n<font color="comment">${paper.isPreprint ? "预印本" : "正式发表"} · ${trim(paper.venue || paper.source || "学术来源", 45)}</font>`),
    `[查看完整日报](${url})`
  ].join("\n\n");

  return { title, markdown, wecom };
}

async function sendWeCom(webhook, content) {
  const response = await postJson(webhook, {
    msgtype: "markdown",
    markdown: { content }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || (json.errcode !== undefined && json.errcode !== 0)) {
    throw new Error(`WeCom push failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  console.log("[notify] WeCom delivered.");
}

async function sendPushPlus(token, title, content) {
  const response = await postJson("https://www.pushplus.plus/send", {
    token,
    title,
    content,
    template: "markdown"
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || (json.code !== undefined && json.code !== 200)) {
    throw new Error(`PushPlus push failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  console.log("[notify] PushPlus delivered.");
}

async function sendServerChan(sendKey, title, desp) {
  const response = await postJson(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, { title, desp });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`ServerChan push failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  console.log("[notify] ServerChan delivered.");
}

async function postJson(url, payload) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "UAV-PLS-Radar/1.0" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000)
  });
}

function trim(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dateInTimezone(date, zone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysBetween(from, to) {
  if (!from) return Number.POSITIVE_INFINITY;
  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}
