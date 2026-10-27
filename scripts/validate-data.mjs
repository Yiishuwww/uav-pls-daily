import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const text = await readFile(path.join(ROOT, "site", "data.js"), "utf8");
const match = text.match(/window\.UAV_PLS_DATA\s*=\s*([\s\S]*);\s*$/);
const errors = [];

if (!match) errors.push("site/data.js 无法解析");
const data = match ? JSON.parse(match[1]) : null;

if (data) {
  if (!data.meta?.generatedAt) errors.push("缺少 meta.generatedAt");
  if (!Array.isArray(data.papers) || !data.papers.length) errors.push("论文列表为空");
  if (!Array.isArray(data.daily)) errors.push("daily 不是数组");

  const ids = new Set();
  const titles = new Map();
  for (const [index, paper] of data.papers.entries()) {
    const prefix = `papers[${index}]`;
    if (!paper.id) errors.push(`${prefix} 缺少 id`);
    if (ids.has(paper.id)) errors.push(`${prefix} 重复 id: ${paper.id}`);
    ids.add(paper.id);
    if (!paper.title) errors.push(`${prefix} 缺少标题`);
    if (!paper.url || !/^https?:\/\//.test(paper.url)) errors.push(`${prefix} 链接无效`);
    if (!paper.publishedAt || !/^\d{4}-\d{2}-\d{2}$/.test(paper.publishedAt)) errors.push(`${prefix} 日期无效`);
    if (!(paper.tags || []).includes("物理层安全") || !(paper.tags || []).includes("无人机通信")) {
      errors.push(`${prefix} 未同时包含两个基础主题标签`);
    }
    if (Number(paper.score) < Number(data.meta.minRelevanceScore || 0)) errors.push(`${prefix} 相关度低于阈值`);
    const titleKey = normalizeTitle(paper.title);
    if (titles.has(titleKey)) errors.push(`${prefix} 与 papers[${titles.get(titleKey)}] 标题重复`);
    titles.set(titleKey, index);
  }

  if (errors.length) {
    console.error("Validation failed:");
    for (const error of errors) console.error(` - ${error}`);
    process.exitCode = 1;
  } else {
    const sources = data.stats?.sourceCounts || {};
    console.log(`Validation passed: ${data.papers.length} papers, ${data.daily.length} daily groups.`);
    console.log(`Sources: ${Object.entries(sources).map(([name, count]) => `${name}=${count}`).join(", ")}`);
    console.log(`Generated: ${data.meta.generatedAt}`);
  }
}

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
