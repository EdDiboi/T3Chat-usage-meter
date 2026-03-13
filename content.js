(function () {
  "use strict";

  const STYLE_ID = "t3-session-usage-style";
  const METER_ID = "t3-session-usage-meter";
  const RESET_TOOLTIP_ID = "t3-session-reset-tooltip";
  const PARENT_ROW_CLASS = "t3-session-usage-parent-row";
  const REFRESH_INTERVAL_MS = 90_000;
  const POST_SEND_REFRESH_DELAYS_MS = [1400, 4200, 8500];
  const INITIAL_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
  const DEFAULT_PRIMARY_FALLBACK = "rgb(162, 59, 103)";
  const DEFAULT_MARKER_COLOR = "#de2929";
  const CUSTOMER_DATA_TRPC_PATH =
    "/api/trpc/getCustomerData?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22sessionId%22%3Anull%7D%2C%22meta%22%3A%7B%22values%22%3A%7B%22sessionId%22%3A%5B%22undefined%22%5D%7D%7D%7D%7D";
  const SUBSCRIPTION_DATA_TRPC_PATH =
    "/api/trpc/getSubscriptionData?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D%7D";
  const TRPC_HEADERS = {
    "trpc-accept": "application/jsonl",
    "x-trpc-batch": "true",
    "x-trpc-source": "web-client"
  };

  let isFetching = false;
  let isFetchingReset = false;
  let refreshTimer = null;
  let observer = null;
  let ensureQueued = false;
  let postSendTimers = [];
  let initialRefreshTimers = [];
  let lastKnownPercent = null;
  let lastKnownMonthlyPercent = null;
  let lastKnownResetText = null;
  let resetTooltipEl = null;

  function clampPercent(value) {
    if (!Number.isFinite(value)) return null;
    if (value < 0 || value > 100) return null;
    return Math.round(value);
  }

  function normalizeMetricNumber(value) {
    if (typeof value !== "number") return null;
    if (!Number.isFinite(value)) return null;
    if (value < 0) return null;
    return value;
  }

  function roundMetricPercent(value) {
    const normalized = normalizeMetricNumber(value);
    if (normalized === null) return null;
    return clampPercent(Math.min(100, normalized));
  }

  function toRemainingPercent(usedPercent) {
    const normalized = normalizeMetricNumber(usedPercent);
    if (normalized === null) return null;
    return clampPercent(100 - Math.min(100, normalized));
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${METER_ID} {
        display: flex;
        flex-direction: row;
        align-items: center;
        align-self: center;
        gap: 4px;
        width: 224px;
        max-width: min(72vw, 280px);
        margin-top: 0;
        margin-bottom: 0;
        pointer-events: auto;
        --t3-primary: var(--primary, ${DEFAULT_PRIMARY_FALLBACK});
        --t3-marker-color: ${DEFAULT_MARKER_COLOR};
        --t3-usage-font-family: inherit;
        --t3-usage-font-size: 12px;
        --t3-usage-line-height: 1;
        --t3-usage-font-weight: 500;
      }

      #${METER_ID} .t3-usage-text-row {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        white-space: nowrap;
      }

      .${PARENT_ROW_CLASS} {
        align-items: center !important;
      }

      #${METER_ID} .t3-usage-title {
        font-family: var(--t3-usage-font-family);
        font-size: var(--t3-usage-font-size);
        line-height: var(--t3-usage-line-height);
        font-weight: var(--t3-usage-font-weight);
        color: var(--foreground, currentColor);
        white-space: nowrap;
        margin-right: 2px;
        cursor: help;
      }

      #${METER_ID} .t3-usage-value {
        font-family: var(--t3-usage-font-family);
        font-size: var(--t3-usage-font-size);
        line-height: var(--t3-usage-line-height);
        color: var(--muted-foreground, #8b95a7);
        font-weight: var(--t3-usage-font-weight);
        white-space: nowrap;
      }

      #${METER_ID} .t3-usage-progress {
        position: relative;
        flex: 1 1 140px;
        min-width: 130px;
      }

      #${METER_ID} .t3-usage-track {
        position: relative;
        height: 6px;
        border-radius: 999px;
        background: rgba(162, 59, 103, 0.2);
        background: color-mix(in oklab, var(--t3-primary) 20%, transparent);
        overflow: hidden;
        width: 100%;
      }

      #${METER_ID} .t3-usage-fill {
        height: 100%;
        width: 0%;
        background: var(--t3-primary);
        border-radius: 999px;
        transition: width 220ms ease;
      }

      #${METER_ID} .t3-usage-marker {
        position: absolute;
        bottom: 0;
        left: 0%;
        width: 3px;
        height: 6px;
        display: none;
        background: var(--t3-marker-color);
        z-index: 2;
        cursor: help;
        transform: translateX(-50%);
        pointer-events: auto;
      }

      #${METER_ID} .t3-usage-marker::before {
        content: "";
        position: absolute;
        top: -8px;
        left: 50%;
        transform: translateX(-50%);
        border-left: 5.5px solid transparent;
        border-right: 5.5px solid transparent;
        border-top: 8px solid var(--t3-marker-color);
      }

      #${RESET_TOOLTIP_ID} {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2147483647;
        pointer-events: none;
        white-space: nowrap;
        border-radius: 6px;
        background: rgba(162, 59, 103, 0.2);
        background: color-mix(in oklab, var(--primary, rgb(162, 59, 103)) 20%, transparent);
        color: var(--foreground, currentColor);
        font-size: 12px;
        line-height: 1.2;
        padding: 6px 8px;
        opacity: 0;
        transform: translate(-50%, -100%);
        transition: opacity 120ms ease;
      }

      #${RESET_TOOLTIP_ID}[data-show="true"] {
        opacity: 1;
      }
    `;

    document.head.appendChild(style);
  }

  function createMeter() {
    const meter = document.createElement("div");
    meter.id = METER_ID;

    const textRow = document.createElement("div");
    textRow.className = "t3-usage-text-row";

    const title = document.createElement("span");
    title.className = "t3-usage-title";
    title.textContent = "Session:";

    const value = document.createElement("span");
    value.className = "t3-usage-value";
    value.textContent = "--%";

    textRow.addEventListener("mouseenter", () => showResetTooltip(textRow));
    textRow.addEventListener("mouseleave", hideResetTooltip);
    textRow.addEventListener("mousemove", () => showResetTooltip(textRow));

    textRow.append(title, value);

    const progress = document.createElement("div");
    progress.className = "t3-usage-progress";

    const track = document.createElement("div");
    track.className = "t3-usage-track";

    const fill = document.createElement("div");
    fill.className = "t3-usage-fill";
    track.appendChild(fill);

    const marker = document.createElement("div");
    marker.className = "t3-usage-marker";
    marker.addEventListener("mouseenter", () => showOverageTooltip(marker));
    marker.addEventListener("mouseleave", hideResetTooltip);
    marker.addEventListener("mousemove", () => showOverageTooltip(marker));

    progress.append(track, marker);
    meter.append(textRow, progress);
    applyUsageSnapshotToMeter(meter, lastKnownPercent, lastKnownMonthlyPercent);
    return meter;
  }

  function ensureResetTooltipElement() {
    if (resetTooltipEl && resetTooltipEl.isConnected) return resetTooltipEl;
    const el = document.createElement("div");
    el.id = RESET_TOOLTIP_ID;
    el.setAttribute("role", "tooltip");
    el.dataset.show = "false";
    document.body.appendChild(el);
    resetTooltipEl = el;
    return el;
  }

  function hideResetTooltip() {
    if (!resetTooltipEl) return;
    resetTooltipEl.dataset.show = "false";
  }

  function showTooltip(anchorEl, tooltipText) {
    if (!(anchorEl instanceof HTMLElement)) return;
    const tooltip = ensureResetTooltipElement();
    tooltip.textContent = tooltipText;

    const rect = anchorEl.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = Math.max(12, rect.top - 8);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.dataset.show = "true";
  }

  function showResetTooltip(anchorEl) {
    showTooltip(anchorEl, lastKnownResetText || "Reset info loading...");
  }

  function buildOverageTooltip(monthlyPercent) {
    const safeMonthlyPercent = roundMetricPercent(monthlyPercent);
    if (safeMonthlyPercent === null) return "Overage unavailable";
    const remainingPercent = clampPercent(100 - safeMonthlyPercent);
    if (remainingPercent === null) return "Overage unavailable";
    return `Overage left: ${remainingPercent}%`;
  }

  function showOverageTooltip(anchorEl) {
    showTooltip(anchorEl, buildOverageTooltip(lastKnownMonthlyPercent));
  }

  function findAttachAnchor() {
    const form = document.querySelector("form#chat-input-form");
    if (!form) return null;
    const labeledAnchor = form.querySelector('label[aria-label="Attach a file"]');
    if (labeledAnchor) return labeledAnchor;

    const labels = form.querySelectorAll("label");
    for (const label of labels) {
      if (label.querySelector('input[type="file"]')) {
        return label;
      }
    }

    return null;
  }

  function syncTypographyFromAttach(meter, attachAnchor) {
    if (!meter || !attachAnchor) return;
    const styles = window.getComputedStyle(attachAnchor);
    const fontFamily = styles.fontFamily;
    const fontSize = styles.fontSize;
    const lineHeight = styles.lineHeight;
    const fontWeight = styles.fontWeight;

    if (fontFamily) {
      meter.style.setProperty("--t3-usage-font-family", fontFamily);
    }
    if (fontSize) {
      meter.style.setProperty("--t3-usage-font-size", fontSize);
    }
    if (lineHeight && lineHeight !== "normal") {
      meter.style.setProperty("--t3-usage-line-height", lineHeight);
    }
    if (fontWeight) {
      meter.style.setProperty("--t3-usage-font-weight", fontWeight);
    }
  }

  function ensureMeter() {
    injectStyles();

    const anchor = findAttachAnchor();
    if (!anchor) return null;

    const host = anchor.closest("div.shrink-0") || anchor;
    const parent = host.parentElement;
    if (!parent) return null;
    parent.classList.add(PARENT_ROW_CLASS);

    let meter = document.getElementById(METER_ID);
    if (!meter) {
      meter = createMeter();
    }

    if (meter.parentElement !== parent || meter.previousElementSibling !== host) {
      host.insertAdjacentElement("afterend", meter);
    }
    syncTypographyFromAttach(meter, anchor);
    applyResetTooltip(meter);
    return meter;
  }

  function applyResetTooltip(meter) {
    const titleEl = meter.querySelector(".t3-usage-title");
    const textRowEl = meter.querySelector(".t3-usage-text-row");
    const markerEl = meter.querySelector(".t3-usage-marker");

    const tooltip = lastKnownResetText || "Reset info loading...";

    if (titleEl instanceof HTMLElement) {
      titleEl.title = tooltip;
    }

    if (textRowEl instanceof HTMLElement) {
      textRowEl.title = tooltip;
    }

    if (markerEl instanceof HTMLElement) {
      markerEl.title = buildOverageTooltip(lastKnownMonthlyPercent);
    }
  }

  function buildMeterTitle(percent, monthlyPercent) {
    const usagePart = percent === null ? "Session usage unavailable" : `Session usage: ${percent}%`;
    const monthlyPart = monthlyPercent === null ? null : buildOverageTooltip(monthlyPercent);
    if (lastKnownResetText) {
      return [usagePart, monthlyPart, lastKnownResetText].filter(Boolean).join("\n");
    }
    return [usagePart, monthlyPart].filter(Boolean).join("\n");
  }

  function applyUsageSnapshotToMeter(meter, percent, monthlyPercent) {
    const value = meter.querySelector(".t3-usage-value");
    const fill = meter.querySelector(".t3-usage-fill");
    const marker = meter.querySelector(".t3-usage-marker");
    if (!value || !fill || !marker) return false;

    const safePercent = clampPercent(percent);
    const safeMonthlyPercent = roundMetricPercent(monthlyPercent);
    marker.style.display = safeMonthlyPercent === null ? "none" : "block";
    marker.style.left = safeMonthlyPercent === null ? "0%" : `${safeMonthlyPercent}%`;

    if (safePercent === null) {
      value.textContent = "--%";
      fill.style.width = "0%";
      meter.title = buildMeterTitle(null, safeMonthlyPercent);
      return false;
    }

    value.textContent = `${safePercent}%`;
    fill.style.width = `${safePercent}%`;
    meter.title = buildMeterTitle(safePercent, safeMonthlyPercent);
    return true;
  }

  function updateMeter(percent, monthlyPercent) {
    const meter = ensureMeter();
    if (!meter) return;

    applyUsageSnapshotToMeter(meter, percent, monthlyPercent);
    lastKnownPercent = clampPercent(percent);
    lastKnownMonthlyPercent = roundMetricPercent(monthlyPercent);
  }

  function extractPercentLiteral(text) {
    if (!text) return null;
    const match = text.match(/(\d{1,3})\s*%/);
    if (!match) return null;
    return clampPercent(Number.parseInt(match[1], 10));
  }

  function normalizeResetText(text) {
    if (!text) return null;
    const compact = text.replace(/\s+/g, " ").trim();
    if (!compact) return null;

    const exact = compact.match(/resets?\s+(?:in|on|at)\s+[^.]+/i);
    if (exact) {
      return exact[0].trim();
    }

    if (/reset/i.test(compact) && compact.length <= 120) {
      return compact;
    }

    return null;
  }

  function parseJsonSafe(rawText) {
    if (!rawText) return null;
    try {
      return JSON.parse(rawText);
    } catch {
      return null;
    }
  }

  function parseTrpcPayloads(rawText) {
    if (!rawText) return [];
    const cleaned = rawText.trim().replace(/^\)\]\}',?\s*/, "");
    if (!cleaned) return [];

    const whole = parseJsonSafe(cleaned);
    if (whole !== null) {
      return Array.isArray(whole) ? whole : [whole];
    }

    const payloads = [];
    const lines = cleaned.split(/\n+/);
    for (const line of lines) {
      const chunk = line.trim();
      if (!chunk) continue;
      const parsed = parseJsonSafe(chunk);
      if (parsed !== null) {
        payloads.push(parsed);
      }
    }
    return payloads;
  }

  function findNamedMetricInValue(rootValue, targetKey) {
    const normalizedTarget = String(targetKey).toLowerCase();
    const stack = [rootValue];

    while (stack.length > 0) {
      const value = stack.pop();
      if (value === null || value === undefined) continue;

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i -= 1) {
          stack.push(value[i]);
        }
        continue;
      }

      if (typeof value !== "object") continue;

      for (const [key, childValue] of Object.entries(value)) {
        if (String(key).toLowerCase() === normalizedTarget) {
          return childValue;
        }
        stack.push(childValue);
      }
    }

    return null;
  }

  function pickBetterPercent(current, nextPercent, nextScore) {
    if (nextPercent === null) return current;
    if (!current) return { percent: nextPercent, score: nextScore };
    if (nextScore > current.score) return { percent: nextPercent, score: nextScore };
    if (nextScore === current.score && nextPercent > current.percent) {
      return { percent: nextPercent, score: nextScore };
    }
    return current;
  }

  function findPercentCandidateInValue(rootValue) {
    const stack = [{ value: rootValue, path: [] }];
    let best = null;

    while (stack.length > 0) {
      const { value, path } = stack.pop();
      if (value === null || value === undefined) continue;

      const key = typeof path[path.length - 1] === "string" ? path[path.length - 1].toLowerCase() : "";
      const pathText = path
        .map((part) => String(part))
        .join(".")
        .toLowerCase();
      const isUsedPercentKey = /(usageperiodpercentage|percentused|usedpercentage|consumedpercent|spentpercent)/.test(
        pathText
      );
      const isRemainingPercentKey = /(remainingpercent|percentremaining|availablepercent|unusedpercent)/.test(
        pathText
      );

      if (typeof value === "string") {
        const text = value.trim();
        const percentFromLiteral = extractPercentLiteral(text);
        if (percentFromLiteral !== null) {
          let candidatePercent = percentFromLiteral;
          let score = 18;

          if (/used/i.test(text) && !/remaining/i.test(text)) {
            candidatePercent = clampPercent(100 - percentFromLiteral);
            score += 16;
          }
          if (/remaining/i.test(text)) {
            score += 18;
          }
          if (isUsedPercentKey) {
            candidatePercent = clampPercent(100 - percentFromLiteral);
            score += 20;
          }
          if (isRemainingPercentKey) {
            score += 20;
          }
          if (/(session|usage|remaining|used|quota|limit)/i.test(text)) score += 26;
          if (/(percent|pct|usage|remaining|session|quota|limit)/i.test(key)) score += 14;
          if (/(percent|pct|usage|remaining|session|quota|limit)/i.test(pathText)) score += 6;

          best = pickBetterPercent(best, candidatePercent, score);
        } else if (/^\d{1,3}$/.test(text)) {
          const rawPercent = clampPercent(Number.parseInt(text, 10));
          if (rawPercent !== null && /(percent|pct|usage|remaining|session|quota|limit)/i.test(pathText)) {
            const candidatePercent = isUsedPercentKey ? clampPercent(100 - rawPercent) : rawPercent;
            const score = isUsedPercentKey ? 56 : isRemainingPercentKey ? 58 : 24;
            best = pickBetterPercent(best, candidatePercent, score);
          }
        }
        continue;
      }

      if (typeof value === "number") {
        const rawPercent = clampPercent(value);
        if (rawPercent !== null) {
          let candidatePercent = rawPercent;
          let score = 1;

          if (isUsedPercentKey) {
            candidatePercent = clampPercent(100 - rawPercent);
            score = 62;
          } else if (isRemainingPercentKey) {
            score = 60;
          } else {
            if (/(percent|pct)/i.test(pathText)) score += 28;
            if (/(session|usage|remaining|used|quota|limit)/i.test(pathText)) score += 12;
          }

          best = pickBetterPercent(best, candidatePercent, score);
        }
        continue;
      }

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i -= 1) {
          stack.push({ value: value[i], path: path.concat(i) });
        }
        continue;
      }

      if (typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value)) {
          stack.push({ value: childValue, path: path.concat(childKey) });
        }
      }
    }

    return best;
  }

  function pickBetterReset(current, nextText, nextScore) {
    if (!nextText) return current;
    if (!current) return { text: nextText, score: nextScore };
    if (nextScore > current.score) return { text: nextText, score: nextScore };
    return current;
  }

  function formatResetMinutes(minutes) {
    if (!Number.isFinite(minutes)) return null;
    const wholeMinutes = Math.max(0, Math.round(minutes));
    if (wholeMinutes <= 1) return "Resets in 1 minute";
    if (wholeMinutes < 60) return "Resets in " + wholeMinutes + " minutes";
    const hours = Math.round(wholeMinutes / 60);
    if (hours <= 1) return "Resets in 1 hour";
    return "Resets in " + hours + " hours";
  }

  function formatResetTimestamp(epochMs) {
    if (!Number.isFinite(epochMs)) return null;
    const target = Number(epochMs);
    if (!Number.isFinite(target) || target <= Date.now()) return null;
    const remainingMinutes = Math.round((target - Date.now()) / 60000);
    return formatResetMinutes(remainingMinutes);
  }

  function findResetCandidateInValue(rootValue) {
    const stack = [{ value: rootValue, path: [] }];
    let best = null;

    while (stack.length > 0) {
      const { value, path } = stack.pop();
      if (value === null || value === undefined) continue;

      const pathText = path
        .map((part) => String(part))
        .join(".")
        .toLowerCase();

      if (typeof value === "string") {
        const resetText = normalizeResetText(value);
        if (resetText) {
          let score = 18;
          if (/resets?\s+in/i.test(resetText)) score += 16;
          if (/reset/.test(pathText)) score += 12;
          best = pickBetterReset(best, resetText, score);
        }
        continue;
      }

      if (typeof value === "number") {
        if (/usagefourhournextresetat|usagewindownextresetat|nextresetat|resetat/.test(pathText)) {
          const fromTimestamp = formatResetTimestamp(value);
          best = pickBetterReset(best, fromTimestamp, 28);
        }

        if (/reset/.test(pathText) && /(minute|min)/.test(pathText)) {
          best = pickBetterReset(best, formatResetMinutes(value), 22);
        }

        if (/reset/.test(pathText) && /(hour|hr)/.test(pathText)) {
          best = pickBetterReset(best, formatResetMinutes(value * 60), 22);
        }
        continue;
      }

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i -= 1) {
          stack.push({ value: value[i], path: path.concat(i) });
        }
        continue;
      }

      if (typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value)) {
          stack.push({ value: childValue, path: path.concat(childKey) });
        }
      }
    }

    return best;
  }

  function extractPercentFromRawText(rawText) {
    if (!rawText) return null;
    const lines = rawText.split(/\n+/);
    let best = null;
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      const value = extractPercentLiteral(text);
      if (value === null) continue;
      let score = 4;
      if (/(session|usage|remaining|used|quota|limit)/i.test(text)) {
        score += 12;
      }
      best = pickBetterPercent(best, value, score);
    }
    return best ? best.percent : null;
  }

  function extractPercentFromTrpcResponse(rawText) {
    const payloads = parseTrpcPayloads(rawText);
    let best = null;

    for (const payload of payloads) {
      const candidate = findPercentCandidateInValue(payload);
      if (!candidate) continue;
      best = pickBetterPercent(best, candidate.percent, candidate.score);
    }

    if (best) return best.percent;
    return extractPercentFromRawText(rawText);
  }

  function extractUsageSnapshotFromTrpcResponse(rawText) {
    const payloads = parseTrpcPayloads(rawText);

    for (const payload of payloads) {
      const fourHourUsed = normalizeMetricNumber(findNamedMetricInValue(payload, "usageFourHourPercentage"));
      const monthUsed = normalizeMetricNumber(findNamedMetricInValue(payload, "usageMonthPercentage"));
      const periodUsed = normalizeMetricNumber(findNamedMetricInValue(payload, "usagePeriodPercentage"));
      const sessionPercent = toRemainingPercent(fourHourUsed ?? periodUsed);
      const monthlyPercent = roundMetricPercent(monthUsed);

      if (sessionPercent !== null || monthlyPercent !== null) {
        return {
          sessionPercent,
          monthlyPercent
        };
      }
    }

    const fallbackPercent = extractPercentFromTrpcResponse(rawText);
    return {
      sessionPercent: fallbackPercent,
      monthlyPercent: null
    };
  }

  function extractResetFromTrpcResponse(rawText) {
    const payloads = parseTrpcPayloads(rawText);
    let best = null;

    for (const payload of payloads) {
      const fourHourReset = formatResetTimestamp(findNamedMetricInValue(payload, "usageFourHourNextResetAt"));
      if (fourHourReset) {
        best = pickBetterReset(best, fourHourReset, 80);
      }

      const candidate = findResetCandidateInValue(payload);
      if (!candidate) continue;
      best = pickBetterReset(best, candidate.text, candidate.score);
    }

    if (best) return best.text;

    const lines = rawText.split(/\n+/);
    for (const line of lines) {
      const resetText = normalizeResetText(line);
      if (resetText) return resetText;
    }

    return null;
  }

  async function fetchTrpcText(path) {
    const response = await fetch(window.location.origin + path, {
      method: "GET",
      credentials: "include",
      headers: TRPC_HEADERS,
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error("TRPC request failed: " + response.status);
    }
    return response.text();
  }

  async function fetchUsageSnapshotFromApi() {
    const customerDataText = await fetchTrpcText(CUSTOMER_DATA_TRPC_PATH);
    const customerSnapshot = extractUsageSnapshotFromTrpcResponse(customerDataText);
    if (customerSnapshot.sessionPercent !== null || customerSnapshot.monthlyPercent !== null) {
      return customerSnapshot;
    }

    const subscriptionDataText = await fetchTrpcText(SUBSCRIPTION_DATA_TRPC_PATH);
    return extractUsageSnapshotFromTrpcResponse(subscriptionDataText);
  }

  async function fetchResetInfoFromApi() {
    const subscriptionDataText = await fetchTrpcText(SUBSCRIPTION_DATA_TRPC_PATH);
    const subscriptionReset = extractResetFromTrpcResponse(subscriptionDataText);
    if (subscriptionReset) return subscriptionReset;

    const customerDataText = await fetchTrpcText(CUSTOMER_DATA_TRPC_PATH);
    return extractResetFromTrpcResponse(customerDataText);
  }

  async function fetchUsageSnapshot() {
    try {
      return await fetchUsageSnapshotFromApi();
    } catch {
      return {
        sessionPercent: null,
        monthlyPercent: null
      };
    }
  }

  async function fetchResetInfo() {
    try {
      return await fetchResetInfoFromApi();
    } catch {
      return null;
    }
  }

  async function refreshResetInfo() {
    if (isFetchingReset) return;
    isFetchingReset = true;

    try {
      const resetText = await fetchResetInfo();
      if (resetText) {
        lastKnownResetText = resetText;
      }
    } finally {
      isFetchingReset = false;
      const meter = ensureMeter();
      if (meter) {
        applyResetTooltip(meter);
        applyUsageSnapshotToMeter(meter, lastKnownPercent, lastKnownMonthlyPercent);
      }
    }
  }

  async function refreshUsage() {
    if (isFetching) return;
    isFetching = true;
    refreshResetInfo();

    try {
      const snapshot = await fetchUsageSnapshot();
      if (snapshot.sessionPercent === null && snapshot.monthlyPercent === null) {
        if (lastKnownPercent === null && lastKnownMonthlyPercent === null) {
          updateMeter(null, null);
        }
      } else {
        updateMeter(snapshot.sessionPercent, snapshot.monthlyPercent);
      }
    } catch {
      if (lastKnownPercent === null && lastKnownMonthlyPercent === null) {
        updateMeter(null, null);
      }
    } finally {
      isFetching = false;
      const meter = ensureMeter();
      if (meter) {
        applyResetTooltip(meter);
        applyUsageSnapshotToMeter(meter, lastKnownPercent, lastKnownMonthlyPercent);
      }
    }
  }

  function queueEnsureMeter() {
    if (ensureQueued) return;
    ensureQueued = true;

    window.requestAnimationFrame(() => {
      ensureQueued = false;
      ensureMeter();
    });
  }

  function startObserver() {
    if (observer || !document.body) return;

    observer = new MutationObserver(() => {
      queueEnsureMeter();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function startRefreshTimer() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
    }

    refreshTimer = window.setInterval(() => {
      refreshUsage();
    }, REFRESH_INTERVAL_MS);
  }

  function clearPostSendTimers() {
    for (const timerId of postSendTimers) {
      window.clearTimeout(timerId);
    }
    postSendTimers = [];
  }

  function schedulePostSendRefreshes() {
    clearPostSendTimers();
    refreshUsage();
    for (const delayMs of POST_SEND_REFRESH_DELAYS_MS) {
      const timerId = window.setTimeout(() => {
        refreshUsage();
      }, delayMs);
      postSendTimers.push(timerId);
    }
  }

  function clearInitialRefreshTimers() {
    for (const timerId of initialRefreshTimers) {
      window.clearTimeout(timerId);
    }
    initialRefreshTimers = [];
  }

  function scheduleInitialRefreshes() {
    clearInitialRefreshTimers();
    refreshUsage();
    refreshResetInfo();
    for (const delayMs of INITIAL_REFRESH_DELAYS_MS) {
      const timerId = window.setTimeout(() => {
        refreshUsage();
        refreshResetInfo();
      }, delayMs);
      initialRefreshTimers.push(timerId);
    }
  }

  function handleFormSubmit(event) {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (target.id !== "chat-input-form") return;
    schedulePostSendRefreshes();
  }

  function handleSendClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button[type="submit"]');
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.disabled) return;
    if (!button.closest("form#chat-input-form")) return;
    schedulePostSendRefreshes();
  }

  function init() {
    injectStyles();
    ensureMeter();
    startObserver();
    startRefreshTimer();
    scheduleInitialRefreshes();

    document.addEventListener("submit", handleFormSubmit, true);
    document.addEventListener("click", handleSendClick, true);
    window.addEventListener("scroll", hideResetTooltip, true);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        ensureMeter();
        scheduleInitialRefreshes();
      } else {
        hideResetTooltip();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
