(() => {
  "use strict";

  const data = window.UAV_PLS_DATA;
  const state = {
    query: "",
    type: "all",
    topic: "all",
    sort: "relevance",
    limit: 12
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const pageSize = 12;
  const timeZone = data?.meta?.timezone || "Asia/Shanghai";
  const papers = Array.isArray(data?.papers) ? data.papers : [];

  if (!data || !papers.length) {
    document.body.classList.add("is-empty");
    const list = $("#paperList");
    if (list) list.innerHTML = '<div class="empty-state"><h3>尚未生成论文数据</h3><p>请先运行 <code>node scripts/fetch-papers.mjs</code>。</p></div>';
    return;
  }

  const today = new Date();
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  });
  const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone
  });
  const shortDateFormatter = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    timeZone
  });

  hydrateHeader();
  renderStats();
  renderTrend();
  renderTopicPulse();
  renderFeatured();
  renderTopicFilters();
  renderPapers();
  bindEvents();

  function hydrateHeader() {
    setText("#heroDate", dateFormatter.format(today));
    setText("#metaTotal", formatNumber(data.stats?.total ?? papers.length));
    setText("#recentCount", formatNumber(data.stats?.last7Days ?? 0));
    setText("#footerUpdated", dateTimeFormatter.format(new Date(data.meta.generatedAt)));

    const ageHours = (Date.now() - new Date(data.meta.generatedAt).getTime()) / 3_600_000;
    const syncState = $("#syncState");
    if (ageHours > 48 && syncState) {
      syncState.classList.add("is-stale");
      syncState.lastElementChild.textContent = "数据待同步";
    }
  }

  function renderStats() {
    setText("#statPublished", formatNumber(data.stats?.published ?? 0));
    setText("#statPreprint", formatNumber(data.stats?.preprints ?? 0));
    setText("#statOpen", formatNumber(data.stats?.openAccess ?? 0));
    const topics = Object.keys(data.stats?.topicCounts || {}).filter((topic) => !["物理层安全", "无人机通信"].includes(topic));
    setText("#statTopics", formatNumber(topics.length));
  }

  function renderTrend() {
    const chart = $("#trendChart");
    if (!chart) return;
    const end = startOfUtcDay(today);
    const buckets = [];

    for (let index = 11; index >= 0; index -= 1) {
      const bucketEnd = addDays(end, -index * 7);
      const bucketStart = addDays(bucketEnd, -6);
      const count = papers.filter((paper) => {
        const date = new Date(`${paper.publishedAt}T12:00:00Z`);
        return date >= bucketStart && date <= bucketEnd;
      }).length;
      buckets.push({ start: bucketStart, end: bucketEnd, count });
    }

    const max = Math.max(...buckets.map((bucket) => bucket.count), 1);
    chart.innerHTML = buckets.map((bucket, index) => {
      const height = Math.max(4, Math.round((bucket.count / max) * 68));
      const label = index % 2 === 0 || index === buckets.length - 1
        ? shortDateFormatter.format(bucket.start)
        : "";
      return `<div class="chart-bar" style="height:${height}px;animation-delay:${index * 35}ms" title="${formatDate(bucket.start)} - ${formatDate(bucket.end)}：${bucket.count} 篇"><span>${escapeHtml(label)}</span></div>`;
    }).join("");
  }

  function renderTopicPulse() {
    const container = $("#topicPulse");
    if (!container) return;
    const topics = Object.entries(data.stats?.topicCounts || {})
      .filter(([topic]) => !["物理层安全", "无人机通信"].includes(topic))
      .sort(([, a], [, b]) => b - a)
      .slice(0, 4);
    container.innerHTML = topics.map(([topic, count]) => `<span>${escapeHtml(topic)} · ${count}</span>`).join("");
  }

  function renderFeatured() {
    const container = $("#featuredGrid");
    if (!container) return;
    const featured = [...papers]
      .sort((a, b) => (b.score - a.score) || String(b.publishedAt).localeCompare(String(a.publishedAt)))
      .slice(0, 3);
    container.innerHTML = featured.map((paper, index) => featuredCard(paper, index)).join("");
  }

  function featuredCard(paper, index) {
    const lead = index === 0;
    const kindText = paper.isPreprint ? "预印本" : "正式发表";
    const tags = (paper.tags || []).slice(0, 4);
    return `<article class="featured-card${lead ? " is-lead" : ""}">
      <div>
        <div class="featured-topline">
          <span class="featured-index">SIGNAL ${String(index + 1).padStart(2, "0")}</span>
          <span class="featured-kind${paper.isPreprint ? " is-preprint" : ""}">${kindText}</span>
        </div>
        <p class="featured-venue">${escapeHtml(paper.venue || paper.source || "学术来源")} · ${formatDate(paper.publishedAt)}</p>
        <h3><a href="${safeUrl(paper.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(paper.title)}</a></h3>
        <p class="featured-guide">${escapeHtml(paper.summaryZh || "暂无自动导读。")}</p>
        <div class="featured-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
      </div>
      <a class="featured-link" href="${safeUrl(paper.url)}" target="_blank" rel="noopener noreferrer">
        <span>阅读论文原文</span><span aria-hidden="true">↗</span>
      </a>
    </article>`;
  }

  function renderTopicFilters() {
    const container = $("#topicFilter");
    if (!container) return;
    const topics = Object.entries(data.stats?.topicCounts || {})
      .filter(([topic]) => !["物理层安全", "无人机通信"].includes(topic))
      .sort(([, a], [, b]) => b - a);
    container.innerHTML = [
      `<button class="topic-chip is-active" type="button" data-topic="all">全部主题 <b>${papers.length}</b></button>`,
      ...topics.map(([topic, count]) => `<button class="topic-chip" type="button" data-topic="${escapeAttribute(topic)}">${escapeHtml(topic)} <b>${count}</b></button>`)
    ].join("");
  }

  function renderPapers() {
    const list = $("#paperList");
    const empty = $("#emptyState");
    const loadWrap = $(".load-more-wrap");
    if (!list || !empty || !loadWrap) return;

    const filtered = getFilteredPapers();
    const visible = filtered.slice(0, state.limit);
    setText("#resultCount", formatNumber(filtered.length));

    if (!filtered.length) {
      list.innerHTML = "";
      list.hidden = true;
      empty.hidden = false;
      loadWrap.hidden = true;
      return;
    }

    list.hidden = false;
    empty.hidden = true;
    list.innerHTML = visible.map((paper, index) => paperCard(paper, index)).join("");

    const hasMore = filtered.length > visible.length;
    loadWrap.hidden = !hasMore;
    setText("#loadMoreCount", hasMore ? `(${filtered.length - visible.length})` : "");
  }

  function getFilteredPapers() {
    const query = state.query.trim().toLowerCase();
    const recentCutoff = addDays(startOfUtcDay(today), -7);
    let output = papers.filter((paper) => {
      if (state.type === "published" && paper.isPreprint) return false;
      if (state.type === "preprint" && !paper.isPreprint) return false;
      if (state.type === "recent" && new Date(`${paper.publishedAt}T12:00:00Z`) < recentCutoff) return false;
      if (state.topic !== "all" && !(paper.tags || []).includes(state.topic)) return false;
      if (!query) return true;
      const haystack = [
        paper.title,
        paper.abstract,
        paper.summaryZh,
        paper.venue,
        ...(paper.authors || []),
        ...(paper.tags || [])
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });

    output = output.sort((a, b) => {
      if (state.sort === "newest") return String(b.publishedAt).localeCompare(String(a.publishedAt)) || b.score - a.score;
      if (state.sort === "oldest") return String(a.publishedAt).localeCompare(String(b.publishedAt)) || b.score - a.score;
      return (b.score - a.score) || String(b.publishedAt).localeCompare(String(a.publishedAt));
    });
    return output;
  }

  function paperCard(paper, index) {
    const authors = formatAuthors(paper.authors);
    const kindText = paper.isPreprint ? "预印本" : "正式发表";
    const doiUrl = paper.doi ? `https://doi.org/${encodeURIComponent(paper.doi)}` : "";
    const arxivUrl = paper.arxivId ? `https://arxiv.org/abs/${encodeURIComponent(paper.arxivId)}` : "";
    const openUrl = paper.openAccessUrl && paper.openAccessUrl !== paper.url ? paper.openAccessUrl : "";
    const links = [
      `<a class="is-primary" href="${safeUrl(paper.url)}" target="_blank" rel="noopener noreferrer">原文</a>`,
      doiUrl && !paper.url.includes(paper.doi) ? `<a href="${safeUrl(doiUrl)}" target="_blank" rel="noopener noreferrer">DOI</a>` : "",
      arxivUrl && !paper.url.includes("arxiv.org") ? `<a href="${safeUrl(arxivUrl)}" target="_blank" rel="noopener noreferrer">arXiv</a>` : "",
      openUrl ? `<a href="${safeUrl(openUrl)}" target="_blank" rel="noopener noreferrer">开放获取</a>` : ""
    ].filter(Boolean).join("");

    return `<article class="paper-card" style="animation-delay:${Math.min(index, 7) * 35}ms">
      <div class="paper-topline">
        <span class="paper-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="paper-kind${paper.isPreprint ? " is-preprint" : ""}">${kindText}</span>
      </div>
      <p class="paper-venue">${escapeHtml(paper.venue || paper.source || "学术来源")} · ${formatDate(paper.publishedAt)}</p>
      <h3 class="paper-title"><a href="${safeUrl(paper.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(paper.title)}</a></h3>
      <p class="paper-authors">${escapeHtml(authors)}</p>
      <p class="paper-guide">${escapeHtml(paper.summaryZh || "暂无自动导读。")}</p>
      ${paper.abstract ? `<details class="paper-abstract"><summary>查看英文摘要</summary><p>${escapeHtml(paper.abstract)}</p></details>` : ""}
      <div class="paper-tags">${(paper.tags || []).slice(0, 5).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="paper-footer">
        <span class="paper-score">相关度 <b>${Number(paper.score || 0).toFixed(1)}</b></span>
        <div class="paper-links">${links}</div>
      </div>
    </article>`;
  }

  function bindEvents() {
    const search = $("#searchInput");
    if (search) {
      search.addEventListener("input", (event) => {
        state.query = event.target.value;
        state.limit = pageSize;
        renderPapers();
      });
    }

    $$(".filter-pill").forEach((button) => {
      button.addEventListener("click", () => {
        state.type = button.dataset.type || "all";
        state.limit = pageSize;
        $$(".filter-pill").forEach((item) => item.classList.toggle("is-active", item === button));
        renderPapers();
      });
    });

    const topicFilter = $("#topicFilter");
    if (topicFilter) {
      topicFilter.addEventListener("click", (event) => {
        const button = event.target.closest("[data-topic]");
        if (!button) return;
        state.topic = button.dataset.topic || "all";
        state.limit = pageSize;
        $$("#topicFilter .topic-chip").forEach((item) => item.classList.toggle("is-active", item === button));
        renderPapers();
      });
    }

    const sort = $("#sortSelect");
    if (sort) {
      sort.addEventListener("change", (event) => {
        state.sort = event.target.value;
        state.limit = pageSize;
        renderPapers();
      });
    }

    const loadMore = $("#loadMore");
    if (loadMore) {
      loadMore.addEventListener("click", () => {
        state.limit += pageSize;
        renderPapers();
      });
    }

    const reset = $("#resetFilters");
    if (reset) {
      reset.addEventListener("click", resetFilters);
    }

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        search?.focus();
      }
      if (event.key === "Escape" && document.activeElement === search) {
        search.value = "";
        state.query = "";
        search.blur();
        renderPapers();
      }
    });
  }

  function resetFilters() {
    state.query = "";
    state.type = "all";
    state.topic = "all";
    state.sort = "relevance";
    state.limit = pageSize;
    const search = $("#searchInput");
    if (search) search.value = "";
    const sort = $("#sortSelect");
    if (sort) sort.value = "relevance";
    $$(".filter-pill").forEach((item) => item.classList.toggle("is-active", item.dataset.type === "all"));
    $$("#topicFilter .topic-chip").forEach((item) => item.classList.toggle("is-active", item.dataset.topic === "all"));
    renderPapers();
  }

  function formatAuthors(authors) {
    if (!authors?.length) return "作者信息暂缺";
    const visible = authors.slice(0, 5);
    return `${visible.join(", ")}${authors.length > visible.length ? " 等" : ""}`;
  }

  function formatDate(value) {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? "日期未知" : dateFormatter.format(date);
  }

  function startOfUtcDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      if (!["http:", "https:"].includes(url.protocol)) return "#";
      return escapeAttribute(url.href);
    } catch {
      return "#";
    }
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }
})();
