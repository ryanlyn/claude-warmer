#!/usr/bin/env node

// src/index.tsx
import { render } from "ink";
import { parseArgs } from "util";

// src/app.tsx
import { useState, useEffect, useCallback, useRef } from "react";
import { Box as Box5, useInput, useApp } from "ink";

// src/lib/sessions.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// src/lib/pricing.ts
var PRICING = [
  { pattern: /opus-4-[56]/, pricing: { baseInputPerM: 5, outputPerM: 25 } },
  { pattern: /opus-4(?:-|$)/, pricing: { baseInputPerM: 15, outputPerM: 75 } },
  { pattern: /sonnet/, pricing: { baseInputPerM: 3, outputPerM: 15 } },
  { pattern: /haiku-4-5/, pricing: { baseInputPerM: 1, outputPerM: 5 } },
  { pattern: /haiku-3-5/, pricing: { baseInputPerM: 0.8, outputPerM: 4 } },
  { pattern: /haiku/, pricing: { baseInputPerM: 1, outputPerM: 5 } }
];
var DEFAULT_PRICING = { baseInputPerM: 3, outputPerM: 15 };
var CACHE_WRITE_1H_MULTIPLIER = 2;
var CACHE_READ_MULTIPLIER = 0.1;
function getModelPricing(model) {
  for (const entry of PRICING) {
    if (entry.pattern.test(model)) {
      return entry.pricing;
    }
  }
  return DEFAULT_PRICING;
}
function calcExpiryCost(cachedTokens, model) {
  const { baseInputPerM } = getModelPricing(model);
  return cachedTokens * baseInputPerM * CACHE_WRITE_1H_MULTIPLIER / 1e6;
}
function calcWarmCost(usage, model) {
  const { baseInputPerM, outputPerM } = getModelPricing(model);
  const readCost = usage.cacheReadInputTokens * baseInputPerM * CACHE_READ_MULTIPLIER / 1e6;
  const writeCost = usage.cacheCreationInputTokens * baseInputPerM * CACHE_WRITE_1H_MULTIPLIER / 1e6;
  const outputCost = usage.outputTokens * outputPerM / 1e6;
  return readCost + writeCost + outputCost;
}
function formatUsd(amount) {
  return `$${amount.toFixed(2)}`;
}
function shortenModelName(model) {
  let short = model.replace(/^claude-/, "");
  short = short.replace(/-\d{8}$/, "");
  return short;
}

// src/lib/types.ts
var WARM_THRESHOLD_MS = 55 * 60 * 1e3;

// src/lib/sessions.ts
function checkPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function parseJsonlFile(content, sessionId) {
  let customTitle = null;
  let lastPrompt = null;
  let lastModel = "";
  let lastCacheRead = 0;
  let lastCacheWrite = 0;
  let lastTimestamp = 0;
  let hasAssistant = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "custom-title" && typeof record.customTitle === "string") {
      customTitle = record.customTitle;
    }
    if (record.type === "last-prompt" && typeof record.lastPrompt === "string") {
      lastPrompt = record.lastPrompt;
    }
    const msg = record.message;
    if (msg?.role === "assistant" && msg.usage) {
      hasAssistant = true;
      const usage = msg.usage;
      lastModel = msg.model || lastModel;
      lastCacheRead = usage.cache_read_input_tokens || 0;
      lastCacheWrite = usage.cache_creation_input_tokens || 0;
      if (typeof record.timestamp === "string") {
        lastTimestamp = new Date(record.timestamp).getTime();
      }
    }
  }
  if (!hasAssistant) return null;
  let name = customTitle || lastPrompt || sessionId;
  if (!customTitle && lastPrompt && lastPrompt.length > 50) {
    name = lastPrompt.slice(0, 50) + "...";
  }
  return {
    name,
    model: lastModel,
    cacheReadTokens: lastCacheRead,
    cacheWriteTokens: lastCacheWrite,
    lastAssistantTimestamp: lastTimestamp
  };
}
function loadPidFiles() {
  const sessionsDir = path.join(os.homedir(), ".claude", "sessions");
  const map = /* @__PURE__ */ new Map();
  if (!fs.existsSync(sessionsDir)) return map;
  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
      const entry = JSON.parse(content);
      const isLive = checkPidAlive(entry.pid);
      map.set(entry.sessionId, { cwd: entry.cwd, pid: entry.pid, isLive });
    } catch {
      continue;
    }
  }
  return map;
}
function discoverSessions(defaultModel) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const pidMap = loadPidFiles();
  const sessions = [];
  const now = Date.now();
  for (const projectDir of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, projectDir);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      let content;
      try {
        content = fs.readFileSync(path.join(projectPath, file), "utf-8");
      } catch {
        continue;
      }
      const parsed = parseJsonlFile(content, sessionId);
      if (!parsed) continue;
      const model = parsed.model || defaultModel;
      const cachedTokens = parsed.cacheReadTokens + parsed.cacheWriteTokens;
      const pidInfo = pidMap.get(sessionId);
      const isWarm = now - parsed.lastAssistantTimestamp < WARM_THRESHOLD_MS;
      sessions.push({
        sessionId,
        name: parsed.name,
        projectDir,
        cwd: pidInfo?.cwd || "",
        model,
        lastAssistantTimestamp: parsed.lastAssistantTimestamp,
        isWarm,
        isLive: pidInfo?.isLive || false,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheWriteTokens: parsed.cacheWriteTokens,
        expiryCostUsd: calcExpiryCost(cachedTokens, model),
        selected: isWarm,
        warmingStatus: "idle",
        warmCostUsd: 0,
        warmCount: 0,
        nextWarmAt: null,
        lastWarmedAt: null,
        lastWarmError: null
      });
    }
  }
  sessions.sort((a, b) => {
    const aCached = a.cacheReadTokens + a.cacheWriteTokens;
    const bCached = b.cacheReadTokens + b.cacheWriteTokens;
    return bCached - aCached;
  });
  return sessions;
}

// src/lib/warmer.ts
import { execFile } from "child_process";
function parseWarmOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
      model: "",
      error: `Failed to parse CLI output: ${stdout.slice(0, 100)}`
    };
  }
  const usage = parsed.usage;
  if (!usage) {
    return {
      usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
      model: parsed.model || "",
      error: "No usage data in response"
    };
  }
  return {
    usage: {
      inputTokens: usage.input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      outputTokens: usage.output_tokens || 0
    },
    model: parsed.model || "",
    error: null
  };
}
function warmSession(sessionId, warmPrompt) {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", warmPrompt, "--resume", sessionId, "--output-format", "json"],
      { timeout: 6e4 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            sessionId,
            usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
            model: "",
            costUsd: 0,
            error: error.message + (stderr ? `: ${stderr.slice(0, 200)}` : "")
          });
          return;
        }
        const parsed = parseWarmOutput(stdout);
        const model = parsed.model;
        const costUsd = parsed.error ? 0 : calcWarmCost(parsed.usage, model);
        resolve({
          sessionId,
          usage: parsed.usage,
          model,
          costUsd,
          error: parsed.error
        });
      }
    );
  });
}

// src/lib/scheduler.ts
var Scheduler = class {
  warmFn;
  intervalMs;
  timer = null;
  constructor(warmFn, intervalMinutes2) {
    this.warmFn = warmFn;
    this.intervalMs = intervalMinutes2 * 60 * 1e3;
  }
  bootstrap(sessions) {
    const now = Date.now();
    return sessions.map((s) => {
      if (s.isLive || !s.selected) {
        return { ...s, nextWarmAt: null };
      }
      return { ...s, nextWarmAt: this.computeFirstWarmTime(s, now) };
    });
  }
  computeFirstWarmTime(session, now) {
    const anchor = session.lastWarmedAt || session.lastAssistantTimestamp;
    const windowEnd = anchor + WARM_THRESHOLD_MS;
    if (windowEnd <= now) {
      return now;
    }
    const remaining = windowEnd - now;
    return now + Math.floor(Math.random() * remaining);
  }
  async tick(sessions, warmPrompt) {
    const now = Date.now();
    const updated = [...sessions];
    for (let i = 0; i < updated.length; i++) {
      const s = updated[i];
      if (!s.nextWarmAt || s.nextWarmAt > now || s.isLive || !s.selected) {
        continue;
      }
      updated[i] = { ...s, warmingStatus: "warming" };
      const result = await this.warmFn(s.sessionId, warmPrompt);
      const warmTime = Date.now();
      if (result.error) {
        updated[i] = {
          ...updated[i],
          warmingStatus: "error",
          lastWarmError: result.error,
          nextWarmAt: warmTime + this.intervalMs
        };
      } else {
        updated[i] = {
          ...updated[i],
          warmingStatus: "success",
          warmCount: s.warmCount + 1,
          warmCostUsd: s.warmCostUsd + result.costUsd,
          lastWarmedAt: warmTime,
          lastWarmError: null,
          nextWarmAt: warmTime + this.intervalMs,
          cacheReadTokens: result.usage.cacheReadInputTokens,
          cacheWriteTokens: result.usage.cacheCreationInputTokens,
          expiryCostUsd: calcExpiryCost(
            result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens,
            result.model || s.model
          ),
          isWarm: true,
          model: result.model || s.model
        };
      }
    }
    return updated;
  }
  addSession(session) {
    const now = Date.now();
    return { ...session, nextWarmAt: this.computeFirstWarmTime(session, now) };
  }
  removeSession(session) {
    return { ...session, nextWarmAt: null };
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
};

// src/components/header.tsx
import { Box, Text } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
function Header({ warming, intervalMinutes: intervalMinutes2, warmPrompt }) {
  return /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginBottom: 1, children: /* @__PURE__ */ jsxs(Box, { children: [
    /* @__PURE__ */ jsx(Text, { bold: true, color: "magenta", children: "Claude Cache Warmer" }),
    /* @__PURE__ */ jsx(Text, { children: "  " }),
    warming ? /* @__PURE__ */ jsx(Text, { bold: true, color: "green", children: "active" }) : /* @__PURE__ */ jsx(Text, { dimColor: true, children: "paused" }),
    /* @__PURE__ */ jsx(Text, { children: "  " }),
    /* @__PURE__ */ jsx(Text, { dimColor: true, children: "interval: " }),
    /* @__PURE__ */ jsxs(Text, { children: [
      intervalMinutes2,
      "m"
    ] }),
    /* @__PURE__ */ jsx(Text, { children: "  " }),
    /* @__PURE__ */ jsx(Text, { dimColor: true, children: "prompt: " }),
    /* @__PURE__ */ jsxs(Text, { children: [
      '"',
      warmPrompt,
      '"'
    ] })
  ] }) });
}

// src/components/session-table.tsx
import { Box as Box3, Text as Text3 } from "ink";

// src/components/session-row.tsx
import { Box as Box2, Text as Text2 } from "ink";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function formatTokens(n) {
  return n.toLocaleString("en-US");
}
function formatCountdown(nextWarmAt) {
  if (!nextWarmAt) return "-";
  const diffMs = nextWarmAt - Date.now();
  if (diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 6e4);
  return `${minutes}m`;
}
function StatusBadge({ session }) {
  if (session.isLive) {
    return /* @__PURE__ */ jsx2(Text2, { color: "blue", children: "[live]" });
  }
  if (session.isWarm) {
    return /* @__PURE__ */ jsx2(Text2, { color: "green", children: "[warm]" });
  }
  return /* @__PURE__ */ jsx2(Text2, { dimColor: true, children: "[cold]" });
}
function WarmingIndicator({ session }) {
  if (session.warmingStatus === "warming") {
    return /* @__PURE__ */ jsx2(Text2, { color: "yellow", children: "warming..." });
  }
  if (session.warmingStatus === "error") {
    return /* @__PURE__ */ jsx2(Text2, { color: "red", children: "error" });
  }
  if (session.warmingStatus === "success") {
    return /* @__PURE__ */ jsx2(Text2, { color: "green", children: "ok" });
  }
  return /* @__PURE__ */ jsx2(Text2, { dimColor: true, children: "idle" });
}
function SessionRow({ session, highlighted }) {
  const cachedTotal = session.cacheReadTokens + session.cacheWriteTokens;
  const selectChar = session.selected ? ">" : " ";
  const bgColor = highlighted ? "gray" : void 0;
  return /* @__PURE__ */ jsxs2(Box2, { children: [
    /* @__PURE__ */ jsx2(Box2, { width: 2, children: /* @__PURE__ */ jsx2(Text2, { color: highlighted ? "cyan" : void 0, backgroundColor: bgColor, children: selectChar }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 7, children: /* @__PURE__ */ jsx2(StatusBadge, { session }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 20, children: /* @__PURE__ */ jsxs2(Text2, { wrap: "truncate-end", bold: highlighted, dimColor: !session.selected, backgroundColor: bgColor, children: [
      " ",
      session.name
    ] }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 10, children: /* @__PURE__ */ jsx2(Text2, { dimColor: !session.selected, children: shortenModelName(session.model) }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 10, justifyContent: "flex-end", children: /* @__PURE__ */ jsx2(Text2, { dimColor: !session.selected, children: formatTokens(cachedTotal) }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 12, justifyContent: "flex-end", children: /* @__PURE__ */ jsx2(Text2, { dimColor: !session.selected, children: formatUsd(session.expiryCostUsd) }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 10, justifyContent: "flex-end", children: /* @__PURE__ */ jsx2(Text2, { dimColor: !session.selected, children: session.selected ? formatUsd(session.warmCostUsd) : "-" }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 7, justifyContent: "flex-end", children: /* @__PURE__ */ jsx2(Text2, { dimColor: !session.selected, children: session.selected ? String(session.warmCount) : "-" }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 10, justifyContent: "flex-end", children: /* @__PURE__ */ jsx2(Text2, { dimColor: !session.selected, children: formatCountdown(session.nextWarmAt) }) }),
    /* @__PURE__ */ jsx2(Box2, { width: 12, justifyContent: "flex-end", children: /* @__PURE__ */ jsx2(WarmingIndicator, { session }) })
  ] });
}

// src/components/session-table.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function ColumnHeader({ label, width, align }) {
  return /* @__PURE__ */ jsx3(Box3, { width, justifyContent: align === "right" ? "flex-end" : void 0, children: /* @__PURE__ */ jsx3(Text3, { bold: true, dimColor: true, children: label }) });
}
function SessionTable({ sessions, highlightedIndex }) {
  return /* @__PURE__ */ jsxs3(Box3, { flexDirection: "column", children: [
    /* @__PURE__ */ jsxs3(Box3, { children: [
      /* @__PURE__ */ jsx3(Box3, { width: 2, children: /* @__PURE__ */ jsx3(Text3, { children: " " }) }),
      /* @__PURE__ */ jsx3(Box3, { width: 7, children: /* @__PURE__ */ jsx3(Text3, { children: " " }) }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Session Name", width: 20 }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Model", width: 10 }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Cached", width: 10, align: "right" }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Expiry Cost", width: 12, align: "right" }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Warm Cost", width: 10, align: "right" }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Warms", width: 7, align: "right" }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Next Warm", width: 10, align: "right" }),
      /* @__PURE__ */ jsx3(ColumnHeader, { label: "Status", width: 12, align: "right" })
    ] }),
    sessions.length === 0 ? /* @__PURE__ */ jsx3(Box3, { marginTop: 1, justifyContent: "center", children: /* @__PURE__ */ jsx3(Text3, { dimColor: true, children: "No sessions found. Check ~/.claude/projects/ for session transcripts." }) }) : sessions.map((session, index) => /* @__PURE__ */ jsx3(
      SessionRow,
      {
        session,
        highlighted: index === highlightedIndex
      },
      session.sessionId
    ))
  ] });
}

// src/components/footer.tsx
import { Box as Box4, Text as Text4 } from "ink";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function KeyHint({ keyName, label }) {
  return /* @__PURE__ */ jsxs4(Box4, { marginRight: 2, children: [
    /* @__PURE__ */ jsx4(Text4, { bold: true, color: "cyan", children: keyName }),
    /* @__PURE__ */ jsxs4(Text4, { dimColor: true, children: [
      " ",
      label
    ] })
  ] });
}
function Footer() {
  return /* @__PURE__ */ jsxs4(Box4, { borderStyle: "round", borderColor: "gray", paddingX: 1, children: [
    /* @__PURE__ */ jsx4(KeyHint, { keyName: "space/enter", label: "toggle" }),
    /* @__PURE__ */ jsx4(KeyHint, { keyName: "a", label: "all" }),
    /* @__PURE__ */ jsx4(KeyHint, { keyName: "n", label: "none" }),
    /* @__PURE__ */ jsx4(KeyHint, { keyName: "w", label: "warm" }),
    /* @__PURE__ */ jsx4(KeyHint, { keyName: "i", label: "interval" }),
    /* @__PURE__ */ jsx4(KeyHint, { keyName: "q", label: "quit" })
  ] });
}

// src/app.tsx
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function App({ intervalMinutes: intervalMinutes2, warmPrompt, defaultModel }) {
  const { exit } = useApp();
  const [sessions, setSessions] = useState(() => discoverSessions(defaultModel));
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [warming, setWarming] = useState(false);
  const schedulerRef = useRef(new Scheduler(warmSession, intervalMinutes2));
  const tickingRef = useRef(false);
  const toggleSelection = useCallback((index) => {
    setSessions((prev) => {
      const updated = [...prev];
      const session = updated[index];
      const newSelected = !session.selected;
      updated[index] = { ...session, selected: newSelected };
      if (warming) {
        if (newSelected) {
          updated[index] = schedulerRef.current.addSession(updated[index]);
        } else {
          updated[index] = schedulerRef.current.removeSession(updated[index]);
        }
      }
      return updated;
    });
  }, [warming]);
  const selectAll = useCallback(() => {
    setSessions(
      (prev) => prev.map((s) => {
        const updated = { ...s, selected: true };
        if (warming) {
          return schedulerRef.current.addSession(updated);
        }
        return updated;
      })
    );
  }, [warming]);
  const selectNone = useCallback(() => {
    setSessions(
      (prev) => prev.map((s) => {
        const updated = { ...s, selected: false };
        if (warming) {
          return schedulerRef.current.removeSession(updated);
        }
        return updated;
      })
    );
  }, [warming]);
  const toggleWarming = useCallback(() => {
    setWarming((prev) => {
      if (!prev) {
        setSessions((current) => schedulerRef.current.bootstrap(current));
      } else {
        setSessions(
          (current) => current.map((s) => ({ ...s, nextWarmAt: null, warmingStatus: s.warmingStatus === "warming" ? "idle" : s.warmingStatus }))
        );
        schedulerRef.current.stop();
      }
      return !prev;
    });
  }, []);
  useEffect(() => {
    if (!warming) return;
    const interval = setInterval(async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        setSessions((current) => {
          schedulerRef.current.tick(current, warmPrompt).then((updated) => {
            setSessions(updated);
          });
          return current;
        });
      } finally {
        tickingRef.current = false;
      }
    }, 3e4);
    return () => clearInterval(interval);
  }, [warming, warmPrompt]);
  useInput((input, key) => {
    if (input === "q") {
      schedulerRef.current.stop();
      exit();
      return;
    }
    if (input === "w") {
      toggleWarming();
      return;
    }
    if (input === "a") {
      selectAll();
      return;
    }
    if (input === "n") {
      selectNone();
      return;
    }
    if (input === " " || key.return) {
      if (sessions.length > 0) {
        toggleSelection(highlightedIndex);
      }
      return;
    }
    if (key.upArrow) {
      setHighlightedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setHighlightedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
      return;
    }
  });
  return /* @__PURE__ */ jsxs5(Box5, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx5(Header, { warming, intervalMinutes: intervalMinutes2, warmPrompt }),
    /* @__PURE__ */ jsx5(SessionTable, { sessions, highlightedIndex }),
    /* @__PURE__ */ jsx5(Footer, {})
  ] });
}

// src/index.tsx
import { jsx as jsx6 } from "react/jsx-runtime";
var { values } = parseArgs({
  options: {
    interval: { type: "string", short: "i", default: "55" },
    prompt: { type: "string", default: "Reply with only the word OK" },
    model: { type: "string", default: "claude-sonnet-4-6" },
    help: { type: "boolean", short: "h", default: false }
  },
  strict: true
});
if (values.help) {
  console.log(`
Claude Cache Warmer - Keep Claude Code session caches alive

Usage: claude-cache-warmer [options]

Options:
  -i, --interval <minutes>  Warming interval in minutes (default: 55)
  --prompt <string>         Custom warm prompt (default: "Reply with only the word OK")
  --model <model>           Default model for pricing (default: "claude-sonnet-4-6")
  -h, --help                Show this help message
`);
  process.exit(0);
}
var intervalMinutes = parseInt(values.interval, 10);
if (isNaN(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 59) {
  console.error("Error: interval must be between 1 and 59 minutes");
  process.exit(1);
}
render(
  /* @__PURE__ */ jsx6(
    App,
    {
      intervalMinutes,
      warmPrompt: values.prompt,
      defaultModel: values.model
    }
  )
);
