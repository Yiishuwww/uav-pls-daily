import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "topics.json");
const DATA_JS_PATH = path.join(ROOT, "site", "data.js");
const DATA_JSON_PATH = path.join(ROOT, "site", "data.json");
const FEED_PATH = path.join(ROOT, "site", "feed.xml");

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const now = new Date();
const today = dateInTimezone(now, config.timezone);
const since = dateMinusDays(today, config.lookbackDays);
const archiveSince = dateMinusDays(today, config.archiveDays);

const UAV_TERMS = [
  "uav", "uavs", "unmanned aerial vehicle", "unmanned aerial vehicles",
  "unmanned aerial system", "unmanned aerial network", "drone", "drones",
  "aerial base station", "aerial network", "aerial communication",
  "low-altitude", "low altitude", "uav-enabled", "uav assisted", "uav-assisted"
];

const SECURITY_TERMS = [
  "physical layer security", "secrecy rate", "secrecy capacity",
  "secrecy outage", "secrecy performance", "secure transmission",
  "secure communication", "eavesdropper", "eavesdropping", "wiretap",
  "covert communication", "covert rate", "covertness", "confidential",
  "information leakage", "jamming attack", "anti-jamming"
];

const CORE_SECURITY_TERMS = [
  "physical layer security", "physical-layer security", "physical layer secrecy",
  "physical-layer secrecy", "secrecy rate", "secrecy capacity", "secrecy outage",
  "secrecy performance", "eavesdropper", "eavesdropping", "wiretap",
  "covert communication", "covert transmission", "covert rate", "covertness",
  "information leakage", "jamming attack", "anti-jamming", "cooperative jamming",
  "friendly jamming"
];

const TAG_RULES = [
  { label: "保密速率", terms: ["secrecy rate", "secrecy capacity", "secrecy outage", "secure rate"] },
  { label: "隐蔽通信", terms: ["covert communication", "covert rate", "covertness", "covert"] },
  { label: "主动干扰", terms: ["jamming", "jammer", "anti-jamming", "friendly jammer"] },
  { label: "RIS/智能反射面", terms: ["reconfigurable intelligent surface", "intelligent reflecting surface", "ris", "irs"] },
  { label: "ISAC/通感一体", terms: ["integrated sensing and communication", "isac", "joint communication and sensing", "sensing and communication"] },
  { label: "NOMA", terms: ["noma", "non-orthogonal multiple access"] },
  { label: "毫米波/太赫兹", terms: ["millimeter wave", "mmwave", "terahertz", "thz"] },
  { label: "资源优化", terms: ["resource allocation", "power allocation", "energy efficiency", "spectrum allocation"] },
  { label: "轨迹/功率优化", terms: ["trajectory", "power control", "beamforming", "placement", "optimization"] },
  { label: "窃听/安全中断", terms: ["eavesdropper", "wiretap", "secrecy outage", "information leakage"] }
];

console.log(`[fetch] Window: ${since} -> ${today}`);

const existing = await loadExistingData();
const records = [];
const arxivRecords = process.env.SKIP_ARXIV === "1" ? [] : await fetchArxivRecords();
if (process.env.SKIP_ARXIV === "1") console.log("[arxiv] Skipped by SKIP_ARXIV=1");
records.push(...arxivRecords);
const openAlexRecords = await fetchOpenAlexRecords();
records.push(...openAlexRecords);

const consolidated = consolidate([
  ...(existing?.papers ?? []).map((paper) => ({ ...paper, persisted: true })),
  ...records
]);

const papers = consolidated
  .map((paper) => {
    const assessment = assessPaper(paper);
    return {
      ...paper,
      accepted: assessment.accepted,
      score: assessment.score,
      tags: assessment.tags,
      reason: assessment.reason,
      summaryZh: buildChineseGuide(paper.title, paper.abstract, assessment.tags)
    };
  })
  .filter((paper) => paper.accepted !== false)
  .filter((paper) => paper.publishedAt && paper.publishedAt >= archiveSince)
  .sort((a, b) => {
    const byDate = String(b.publishedAt).localeCompare(String(a.publishedAt));
    return byDate || b.score - a.score;
  })
  .slice(0, config.maxPapers)
  .map((paper) => {
    const firstSeenAt = paper.firstSeenAt || now.toISOString();
    return {
      ...paper,
      firstSeenAt,
      lastSeenAt: now.toISOString(),
      firstSeenDate: paper.firstSeenDate || dateInTimezone(new Date(firstSeenAt), config.timezone)
    };
  });

const daily = buildDailyDigest(papers, config);
const stats = buildStats(papers, today, config);
const data = {
  meta: {
    title: config.siteTitle,
    subtitle: config.siteSubtitle,
    generatedAt: now.toISOString(),
    timezone: config.timezone,
    lookbackDays: config.lookbackDays,
    archiveDays: config.archiveDays,
    minRelevanceScore: config.minRelevanceScore,
    sources: ["arXiv", "OpenAlex"],
    disclaimer: "自动聚合公开元数据，仅用于科研信息发现；论文结论请以原文为准。"
  },
  stats,
  daily,
  papers
};

if (!papers.length) {
  console.warn("[fetch] No matching papers found. Existing site data was left unchanged.");
  process.exitCode = 0;
} else {
  await writeFile(DATA_JSON_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(DATA_JS_PATH, `window.UAV_PLS_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf8");
  await writeFile(FEED_PATH, buildFeed(data), "utf8");
  console.log(`[fetch] Wrote ${papers.length} papers, ${daily.length} daily groups.`);
  console.log(`[fetch] Latest: ${papers.slice(0, 5).map((paper) => paper.title).join(" | ")}`);
}

async function fetchArxivRecords() {
  const all = [];
  const queries = [
    `(cat:${config.arxiv.categories[0]} OR cat:${config.arxiv.categories[1]} OR cat:${config.arxiv.categories[2]}) AND (all:UAV OR all:drone OR all:"unmanned aerial")`,
    ...config.arxiv.queries
  ];

  let consecutiveFailures = 0;
  for (const [index, query] of queries.entries()) {
    const params = new URLSearchParams({
      search_query: query,
      start: "0",
      max_results: String(config.maxResultsPerQuery),
      sortBy: "submittedDate",
      sortOrder: "descending"
    });

    try {
      const xml = await fetchText(`https://export.arxiv.org/api/query?${params}`, 1);
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => parseArxivEntry(match[1]));
      console.log(`[arxiv] Query ${index + 1}/${queries.length}: ${entries.length} records`);
      all.push(...entries);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      console.warn(`[arxiv] Query failed: ${error.message}`);
      if (consecutiveFailures >= 2) {
        console.warn("[arxiv] Endpoint unavailable; continuing with OpenAlex only.");
        break;
      }
    }

    if (index < queries.length - 1) await sleep(1250);
  }

  return all.filter(Boolean);
}

function parseArxivEntry(entry) {
  const title = collapse(xmlText(entry, "title"));
  const abstract = collapse(xmlText(entry, "summary"));
  const publishedAt = xmlText(entry, "published").slice(0, 10);
  const idUrl = xmlText(entry, "id");
  const arxivId = idUrl.replace(/^.*\/abs\//, "").replace(/v\d+$/, "");
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    .map((match) => collapse(decodeXml(match[1])))
    .filter(Boolean);
  const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((match) => match[1]);
  const alternate = entry.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"[^>]*\/?>/i)
    ?? entry.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"[^>]*\/?>/i);
  const url = decodeXml(alternate?.[1] || idUrl);
  const doiMatch = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
  const doi = doiMatch ? decodeXml(doiMatch[1]).trim() : "";
  const primaryCategory = categories[0] || "";
  const assessment = assessPaper({ title, abstract, venue: "arXiv", isPreprint: true });

  return {
    id: stableId(doi || arxivId || title),
    title,
    abstract,
    authors,
    publishedAt,
    updatedAt: xmlText(entry, "updated").slice(0, 10) || publishedAt,
    source: "arXiv",
    sources: ["arXiv"],
    sourceType: "preprint",
    venue: "arXiv",
    primaryCategory,
    arxivId,
    doi,
    url,
    openAccessUrl: url,
    citations: 0,
    isPreprint: true,
    isOpenAccess: true,
    accepted: assessment.accepted,
    score: assessment.score,
    tags: assessment.tags,
    summaryZh: buildChineseGuide(title, abstract, assessment.tags),
    reason: assessment.reason
  };
}

async function fetchOpenAlexRecords() {
  const all = [];
  for (const [index, query] of config.openalex.queries.entries()) {
    const params = new URLSearchParams({
      search: query,
      filter: `from_publication_date:${since},to_publication_date:${today}`,
      sort: "publication_date:desc",
      "per-page": String(Math.min(config.maxResultsPerQuery, 100)),
      mailto: config.contactEmail
    });

    try {
      const response = await fetchWithRetry(`https://api.openalex.org/works?${params}`);
      const json = await response.json();
      const parsed = (json.results || []).map(parseOpenAlexWork).filter(Boolean);
      console.log(`[openalex] Query ${index + 1}/${config.openalex.queries.length}: ${parsed.length} records`);
      all.push(...parsed);
    } catch (error) {
      console.warn(`[openalex] Query failed: ${error.message}`);
    }

    if (index < config.openalex.queries.length - 1) await sleep(300);
  }
  return all;
}

function parseOpenAlexWork(work) {
  if (!work?.display_name || ["paratext", "dataset", "software"].includes(work.type)) return null;
  const title = collapse(work.display_name);
  const abstract = abstractFromInvertedIndex(work.abstract_inverted_index);
  const publishedAt = work.publication_date || (work.publication_year ? `${work.publication_year}-01-01` : "");
  if (!publishedAt || publishedAt < since) return null;

  const rawVenue = work.primary_location?.source?.display_name || "";
  const venue = (/^DOAJ/i.test(rawVenue) ? work.host_venue?.display_name : rawVenue)
    || work.host_venue?.display_name
    || (work.type === "preprint" ? "Preprint" : "OpenAlex");
  const venueLower = venue.toLowerCase();
  const isPreprint = work.type === "preprint"
    || /arxiv|biorxiv|medrxiv|ssrn|research square|preprint/.test(venueLower);
  const doi = normalizeDoi(work.doi);
  const url = work.primary_location?.landing_page_url
    || (doi ? `https://doi.org/${doi}` : work.id);
  const isOpenAccess = Boolean(work.open_access?.is_oa);
  const openAccessUrl = work.best_oa_location?.pdf_url
    || work.best_oa_location?.landing_page_url
    || "";
  const authors = (work.authorships || [])
    .map((authorship) => authorship.author?.display_name)
    .filter(Boolean);
  const assessment = assessPaper({ title, abstract, venue, isPreprint });

  return {
    id: stableId(doi || title),
    title,
    abstract,
    authors,
    publishedAt,
    updatedAt: work.updated_date?.slice(0, 10) || publishedAt,
    source: "OpenAlex",
    sources: ["OpenAlex"],
    sourceType: isPreprint ? "preprint" : "published",
    venue,
    primaryCategory: work.type || "",
    arxivId: extractArxivId(work),
    doi,
    url,
    openAccessUrl,
    citations: work.cited_by_count || 0,
    isPreprint,
    isOpenAccess,
    accepted: assessment.accepted,
    score: assessment.score,
    tags: assessment.tags,
    summaryZh: buildChineseGuide(title, abstract, assessment.tags),
    reason: assessment.reason
  };
}

function assessPaper({ title, abstract, venue, isPreprint }) {
  const titleText = String(title || "").toLowerCase();
  const abstractText = String(abstract || "").toLowerCase();
  const allText = `${titleText} ${abstractText}`;
  const uavTitle = findTerms(titleText, UAV_TERMS);
  const securityTitle = findTerms(titleText, SECURITY_TERMS);
  const uavAbstract = findTerms(abstractText, UAV_TERMS);
  const securityAbstract = findTerms(abstractText, SECURITY_TERMS);
  const coreSecurityTitle = findTerms(titleText, CORE_SECURITY_TERMS);
  const coreSecurityAbstract = findTerms(abstractText, CORE_SECURITY_TERMS);
  const coreDistinct = new Set([...coreSecurityTitle, ...coreSecurityAbstract]);
  const hasUav = uavTitle.length > 0 || uavAbstract.length > 0;
  const exactPhysicalLayerSecurity = /physical[ -]layer (security|secrecy)/i.test(allText);
  const stronglyAccepted = coreSecurityTitle.length > 0
    || coreDistinct.size >= 2
    || (uavTitle.length > 0 && exactPhysicalLayerSecurity);

  if (!hasUav || !stronglyAccepted) {
    return { accepted: false, score: 0, tags: [], reason: "标题或摘要未形成足够的无人机物理层安全证据" };
  }

  const tags = detectTags(allText);
  let score = 3;
  if (uavTitle.length) score += 3;
  if (securityTitle.length) score += 4;
  if (uavAbstract.length) score += 1;
  if (securityAbstract.length) score += 1;
  if (coreSecurityTitle.length) score += 1;
  if (coreSecurityAbstract.length) score += 1;
  if (titleText.includes("physical layer security")) score += 2;
  if (titleText.includes("secrecy") || titleText.includes("covert")) score += 1;
  if (!isPreprint) score += 2;
  score += Math.min(3, Math.max(0, tags.length - 2) * 0.5);
  if (uavTitle.length && securityTitle.length) score += 1;

  const accepted = score >= config.minRelevanceScore;
  const reasonParts = [];
  if (uavTitle.length) reasonParts.push("标题命中无人机主题");
  if (coreSecurityTitle.length) reasonParts.push("标题命中物理层安全核心主题");
  if (coreDistinct.size >= 2) reasonParts.push("摘要形成多重安全证据");
  if (tags.length > 2) reasonParts.push(`涉及${tags.slice(0, 3).join("、")}`);
  if (!isPreprint) reasonParts.push("正式发表记录");

  return {
    accepted,
    score: Number(score.toFixed(1)),
    tags,
    reason: reasonParts.join("；") || "主题相关性匹配"
  };
}

function detectTags(text) {
  const tags = ["物理层安全", "无人机通信"];
  for (const rule of TAG_RULES) {
    if (findTerms(text, rule.terms).length) tags.push(rule.label);
  }
  return [...new Set(tags)];
}

function buildChineseGuide(title, abstract, tags) {
  const topicText = tags.filter((tag) => !["物理层安全", "无人机通信"].includes(tag));
  const focus = topicText.length ? `，重点关注${topicText.slice(0, 3).join("、")}` : "";
  const titleHint = title.length > 112 ? `${title.slice(0, 109)}...` : title;
  const abstractHint = abstract
    ? "摘要提供了系统模型、优化方法与安全性能分析线索。"
    : "当前来源未提供摘要，建议通过原文进一步核验研究问题与结论。";
  return `自动导读：围绕《${titleHint}》所述无人机通信场景${focus}展开。${abstractHint}建议重点阅读系统假设、威胁模型、优化算法与性能界。`;
}

function consolidate(input) {
  const result = [];
  const keyMap = new Map();

  for (const raw of input) {
    if (!raw?.title) continue;
    const candidate = normalizeRecord(raw);
    const keys = recordKeys(candidate);
    let existing = null;
    for (const key of keys) {
      if (keyMap.has(key)) {
        existing = keyMap.get(key);
        break;
      }
    }

    if (existing) {
      mergeRecord(existing, candidate);
      for (const key of recordKeys(existing)) keyMap.set(key, existing);
    } else {
      result.push(candidate);
      for (const key of keys) keyMap.set(key, candidate);
    }
  }

  return result;
}

function normalizeRecord(record) {
  const isPreprint = Boolean(record.isPreprint);
  return {
    ...record,
    title: collapse(record.title),
    abstract: collapse(record.abstract || ""),
    authors: Array.isArray(record.authors) ? record.authors.filter(Boolean).slice(0, 20) : [],
    sources: [...new Set([...(record.sources || []), record.source].filter(Boolean))],
    tags: [...new Set(record.tags || [])],
    doi: normalizeDoi(record.doi),
    arxivId: normalizeArxivId(record.arxivId),
    citations: Number(record.citations || 0),
    score: Number(record.score || 0),
    publishedAt: record.publishedAt || "",
    firstSeenAt: record.firstSeenAt || now.toISOString(),
    isPreprint,
    accepted: record.accepted !== false
  };
}

function mergeRecord(target, candidate) {
  const formalCandidate = !candidate.isPreprint && candidate.sourceType === "published";
  const targetFormal = !target.isPreprint && target.sourceType === "published";
  const preferCandidate = formalCandidate && !targetFormal;

  target.sources = [...new Set([...(target.sources || []), ...(candidate.sources || [])])];
  target.tags = [...new Set([...(target.tags || []), ...(candidate.tags || [])])];
  target.firstSeenAt = earliestIso(target.firstSeenAt, candidate.firstSeenAt);
  target.firstSeenDate = dateInTimezone(new Date(target.firstSeenAt), config.timezone);
  target.publishedAt = target.publishedAt || candidate.publishedAt;
  target.updatedAt = latestIso(target.updatedAt, candidate.updatedAt);
  target.lastSeenAt = now.toISOString();
  target.score = Math.max(target.score || 0, candidate.score || 0);
  target.citations = Math.max(target.citations || 0, candidate.citations || 0);
  target.isOpenAccess = Boolean(target.isOpenAccess || candidate.isOpenAccess);
  target.openAccessUrl = target.openAccessUrl || candidate.openAccessUrl || "";
  target.doi = target.doi || candidate.doi || "";
  target.arxivId = target.arxivId || candidate.arxivId || "";
  target.accepted = target.accepted !== false || candidate.accepted !== false;

  if ((candidate.abstract || "").length > (target.abstract || "").length) target.abstract = candidate.abstract;
  if ((candidate.authors || []).length > (target.authors || []).length) target.authors = candidate.authors;
  if (preferCandidate || (candidate.title || "").length > (target.title || "").length) {
    target.title = candidate.title;
    target.venue = candidate.venue;
    target.primaryCategory = candidate.primaryCategory || target.primaryCategory;
    target.url = candidate.url || target.url;
    target.sourceType = candidate.sourceType;
  }

  const hasFormalSource = target.sources.some((source) => !["arXiv"].includes(source)) && !target.isPreprint;
  target.isPreprint = target.isPreprint && !formalCandidate && !hasFormalSource;
  target.summaryZh = buildChineseGuide(target.title, target.abstract, target.tags);
}

function recordKeys(record) {
  const keys = new Set();
  if (record.doi) keys.add(`doi:${record.doi}`);
  if (record.arxivId) keys.add(`arxiv:${normalizeArxivId(record.arxivId)}`);
  const normalizedTitle = normalizeTitle(record.title);
  if (normalizedTitle.length >= 18) keys.add(`title:${normalizedTitle}`);
  return [...keys];
}

function buildDailyDigest(papers, cfg) {
  const groups = new Map();
  for (const paper of papers) {
    const day = paper.firstSeenDate || dateInTimezone(new Date(paper.firstSeenAt), cfg.timezone);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(paper);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 120)
    .map(([date, items]) => {
      const sorted = [...items].sort((a, b) => b.score - a.score || String(b.publishedAt).localeCompare(String(a.publishedAt)));
      return {
        date,
        count: sorted.length,
        publishedCount: sorted.filter((paper) => !paper.isPreprint).length,
        preprintCount: sorted.filter((paper) => paper.isPreprint).length,
        picks: sorted.slice(0, 5).map((paper) => paper.id)
      };
    });
}

function buildStats(papers, day, cfg) {
  const sevenDaysAgo = dateMinusDays(day, 6);
  const topicCounts = {};
  const sourceCounts = {};
  for (const paper of papers) {
    for (const tag of paper.tags || []) topicCounts[tag] = (topicCounts[tag] || 0) + 1;
    for (const source of paper.sources || [paper.source]) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  }
  return {
    total: papers.length,
    last7Days: papers.filter((paper) => paper.publishedAt >= sevenDaysAgo).length,
    published: papers.filter((paper) => !paper.isPreprint).length,
    preprints: papers.filter((paper) => paper.isPreprint).length,
    openAccess: papers.filter((paper) => paper.isOpenAccess).length,
    topicCounts,
    sourceCounts
  };
}

function buildFeed(data) {
  const entries = data.papers.slice(0, 40).map((paper) => `  <entry>
    <title>${escapeXml(paper.title)}</title>
    <id>${escapeXml(paper.url || paper.id)}</id>
    <link href="${escapeXml(paper.url || paper.id)}"/>
    <updated>${escapeXml(`${paper.publishedAt}T00:00:00+08:00`)}</updated>
    <summary>${escapeXml(paper.summaryZh || paper.abstract || "")}</summary>
    <author>${escapeXml((paper.authors || []).join(", "))}</author>
  </entry>`).join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(data.meta.title)}</title>
  <subtitle>${escapeXml(data.meta.subtitle)}</subtitle>
  <link href="./feed.xml" rel="self"/>
  <updated>${data.meta.generatedAt}</updated>
  <id>urn:uav-pls-radar:feed</id>
${entries}
</feed>
`;
}

async function loadExistingData() {
  try {
    const text = await readFile(DATA_JS_PATH, "utf8");
    const match = text.match(/window\.UAV_PLS_DATA\s*=\s*([\s\S]*);\s*$/);
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return null;
  }
}

async function fetchText(url, attempts = 1) {
  const response = await fetchWithRetry(url, {
    headers: { "User-Agent": `UAV-PLS-Radar/1.0 (${config.contactEmail})` }
  }, attempts, 20_000);
  return response.text();
}

async function fetchWithRetry(url, options = {}, attempts = 3, timeoutMs = 35_000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(800 * attempt);
    }
  }
  throw lastError;
}

function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions || []) words[position] = word;
  }
  return collapse(words.filter(Boolean).join(" "));
}

function xmlText(xml, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapedTag}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function decodeXml(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, " ");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function findTerms(text, terms) {
  return terms.filter((term) => {
    if (term === "uav" || term === "uavs") return /\buavs?\b/.test(text);
    if (term === "ris" || term === "irs") return new RegExp(`\\b${term}\\b`, "i").test(text);
    return text.includes(term);
  });
}

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeDoi(value) {
  return String(value || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase().trim();
}

function normalizeArxivId(value) {
  return String(value || "").replace(/^arxiv:/i, "").replace(/v\d+$/i, "").trim();
}

function extractArxivId(work) {
  const values = [
    ...(work.ids ? Object.values(work.ids) : []),
    work.doi,
    work.primary_location?.landing_page_url,
    work.locations?.map((location) => location.landing_page_url).join(" ")
  ];
  for (const value of values.filter(Boolean)) {
    const match = String(value).match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i);
    if (match) return match[1];
  }
  return "";
}

function stableId(input) {
  const text = String(input || "paper");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `p_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function collapse(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function earliestIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}

function latestIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

function dateInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateMinusDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
