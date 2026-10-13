import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import { normalizeSymbol } from "./config";
import { callTwelveData, testKey, maskKey } from "./twelve";
import { getKeys, addKey, removeKey, toggleKey } from "./storage";
import { fetchAllNews, FREE_SOURCES, searchViaTavily } from "./news";

// 统一文本输出：JSON 字符串
function out(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "Twelve Data Forex MCP", version: "1.0.0" });

  // -- 实时价格 -----------------------------------------------------------
  server.tool(
    "forex_get_price",
    "获取外汇货币对的实时价格。example: EUR/USD, GBP/USD, USD/JPY.",
    {
      symbol: z.string().optional().default("EUR/USD").describe("货币对，如 EUR/USD"),
      timezone: z.string().optional().default("UTC").describe("时区，如 UTC、America/New_York"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(env, "/price", { symbol: normalizeSymbol(args.symbol ?? "EUR/USD"), timezone: args.timezone ?? "UTC" }, { cacheTtlMs: 60_000 });
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- K 线时间序列 --------------------------------------------------------
  server.tool(
    "forex_get_timeseries",
    "获取可直接用于分析或绘制 K 线图的 OHLCV 时间序列。interval 可选 1min,5min,15min,30min,45min,1h,2h,4h,1day,1week,1month。",
    {
      symbol: z.string().optional().default("EUR/USD").describe("货币对，如 EUR/USD"),
      interval: z.enum(["1min", "5min", "15min", "30min", "45min", "1h", "2h", "4h", "1day", "1week", "1month"]).optional().default("1day").describe("K线周期"),
      outputsize: z.number().int().min(1).max(8000).optional().default(30).describe("返回条数 1-8000"),
      timezone: z.string().optional().default("UTC").describe("时区"),
      order: z.enum(["asc", "desc"]).optional().default("desc").describe("排序"),
      dp: z.number().int().optional().default(5).describe("小数位数"),
      fresh: z.boolean().optional().default(false).describe("是否绕过 60 秒缓存请求最新数据；会额外消耗 Twelve Data 额度"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(
          env,
          "/time_series",
          {
            symbol: normalizeSymbol(args.symbol ?? "EUR/USD"),
            interval: args.interval ?? "1day",
            outputsize: String(Math.min(Math.max(Number(args.outputsize ?? 30), 1), 8000)),
            timezone: args.timezone ?? "UTC",
            order: args.order ?? "desc",
            dp: String(args.dp ?? 5),
          },
          { cacheTtlMs: args.fresh ? 0 : 60_000 }
        );
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 外汇对列表 ----------------------------------------------------------
  server.tool(
    "forex_list_pairs",
    "获取 Twelve Data 支持的外汇对列表，可按币种或交易所过滤。",
    {
      currency_base: z.string().optional().describe("基础货币筛选，如 EUR"),
      currency_quote: z.string().optional().describe("计值货币筛选，如 USD"),
      exchange: z.string().optional().describe("交易所筛选，如 Forex"),
    },
    async (args) => {
      try {
        const params: Record<string, string> = {};
        if (args.currency_base) params.currency_base = String(args.currency_base);
        if (args.currency_quote) params.currency_quote = String(args.currency_quote);
        if (args.exchange) params.exchange = String(args.exchange);
        const r = await callTwelveData(env, "/forex_pairs", params, { cacheTtlMs: 60_000 });
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 汇率换算 -----------------------------------------------------------
  server.tool(
    "forex_get_exchange_rate",
    "获取两个货币间的实时汇率。symbol 形如 EUR/USD，也支持带交易所前缀如 FOREX:EUR/USD。",
    {
      symbol: z.string().optional().default("EUR/USD").describe("货币对星号，如 EUR/USD"),
    },
    async (args) => {
      try {
        const sym = normalizeSymbol(args.symbol ?? "EUR/USD");
        const r = await callTwelveData(env, "/exchange_rate", { symbol: sym }, { cacheTtlMs: 60_000 });
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 综合报价 -----------------------------------------------------------
  server.tool(
    "forex_get_quote",
    "获取标的的综合报价（当日开高低收、涨跌幅、近期月/周/年涨跌幅等）。支持外汇对(EUR/USD)、贵金属(XAU/USD 黄金、XAG/USD 白银)、加密货币(BTC/USD)、原油(USOIL、CL)、指数(SPX)等。",
    {
      symbol: z.string().optional().default("EUR/USD").describe("标的，如 EUR/USD、XAU/USD、BTC/USD、CL"),
      timezone: z.string().optional().default("UTC").describe("时区"),
      dp: z.number().int().optional().default(5).describe("小数位数"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(
          env,
          "/quote",
          { symbol: normalizeSymbol(args.symbol ?? "EUR/USD"), timezone: args.timezone ?? "UTC", dp: String(args.dp ?? 5) },
          { cacheTtlMs: 60_000 }
        );
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 通用实时价格（多市场） ----------------------------------------------
  server.tool(
    "forex_get_market_price",
    "获取任意标的的实时价格。支持：外汇对(EUR/USD)、贵金属(XAU/USD 黄金、XAG/USD 白银)、能源(USOIL 原油、NATURAL_GAS)、加密货币(BTC/USD、ETH/USD)、美股(AAPL)等。",
    {
      symbol: z.string().optional().default("XAU/USD").describe("标的，如 XAU/USD、BTC/USD、USOIL、AAPL"),
      timezone: z.string().optional().default("UTC").describe("时区"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(env, "/price", { symbol: normalizeSymbol(args.symbol ?? "XAU/USD"), timezone: args.timezone ?? "UTC" }, { cacheTtlMs: 60_000 });
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 市场开闭状态（免费参考数据，不消耗额度） ------------------------------
  server.tool(
    "forex_get_market_state",
    "查询某标的市场/交易所当前的开闭交易状态（open/closed），以及下一次开盘时间。对做单择时有用。",
    {
      symbol: z.string().optional().default("EUR/USD").describe("标的，如 EUR/USD、XAU/USD、BTC/USD"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(env, "/market_state", { symbol: normalizeSymbol(args.symbol ?? "EUR/USD") }, { cacheTtlMs: 60_000 });
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- RSI 指标 -----------------------------------------------------------
  server.tool(
    "forex_get_rsi",
    "计算 RSI（相对强弱指标），用于衡量涨跌动能与超买/超卖。值 >70 通常超买，<30 超卖。",
    {
      symbol: z.string().optional().default("XAU/USD").describe("标的，如 XAU/USD、EUR/USD、BTC/USD"),
      interval: z.enum(["1min", "5min", "15min", "30min", "45min", "1h", "2h", "4h", "1day", "1week", "1month"]).optional().default("1day").describe("K线周期"),
      time_period: z.number().int().min(1).max(500).optional().default(14).describe("回看周期"),
      outputsize: z.number().int().min(1).max(500).optional().default(50).describe("返回条数"),
      timezone: z.string().optional().default("UTC").describe("时区"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(
          env,
          "/rsi",
          {
            symbol: normalizeSymbol(args.symbol ?? "XAU/USD"),
            interval: args.interval ?? "1day",
            time_period: String(args.time_period ?? 14),
            outputsize: String(args.outputsize ?? 50),
            timezone: args.timezone ?? "UTC",
          },
          { cacheTtlMs: 60_000 }
        );
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- MACD 指标 ----------------------------------------------------------
  server.tool(
    "forex_get_macd",
    "计算 MACD（指数平滑异同移动平均线）。金叉/死叉用于判断趋势转变。",
    {
      symbol: z.string().optional().default("XAU/USD").describe("标的"),
      interval: z.enum(["1min", "5min", "15min", "30min", "45min", "1h", "2h", "4h", "1day", "1week", "1month"]).optional().default("1day").describe("K线周期"),
      fast: z.number().int().optional().default(12).describe("快 EMA 周期"),
      slow: z.number().int().optional().default(26).describe("慢 EMA 周期"),
      signal: z.number().int().optional().default(9).describe("信号线周期"),
      outputsize: z.number().int().min(1).max(500).optional().default(50).describe("返回条数"),
      timezone: z.string().optional().default("UTC").describe("时区"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(
          env,
          "/macd",
          {
            symbol: normalizeSymbol(args.symbol ?? "XAU/USD"),
            interval: args.interval ?? "1day",
            fast: String(args.fast ?? 12),
            slow: String(args.slow ?? 26),
            signal: String(args.signal ?? 9),
            outputsize: String(args.outputsize ?? 50),
            timezone: args.timezone ?? "UTC",
          },
          { cacheTtlMs: 60_000 }
        );
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 布林带指标 ----------------------------------------------------------
  server.tool(
    "forex_get_bollinger",
    "计算布林带（BBands）：上轨/中轨/下轨，判断波动率与超买超卖区间。",
    {
      symbol: z.string().optional().default("XAU/USD").describe("标的"),
      interval: z.enum(["1min", "5min", "15min", "30min", "45min", "1h", "2h", "4h", "1day", "1week", "1month"]).optional().default("1day").describe("K线周期"),
      time_period: z.number().int().min(1).max(500).optional().default(20).describe("周期"),
      stddev: z.number().optional().default(2).describe("标准差倍数"),
      outputsize: z.number().int().min(1).max(500).optional().default(50).describe("返回条数"),
      timezone: z.string().optional().default("UTC").describe("时区"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(
          env,
          "/bbands",
          {
            symbol: normalizeSymbol(args.symbol ?? "XAU/USD"),
            interval: args.interval ?? "1day",
            time_period: String(args.time_period ?? 20),
            stddev: String(args.stddev ?? 2),
            outputsize: String(args.outputsize ?? 50),
            timezone: args.timezone ?? "UTC",
          },
          { cacheTtlMs: 60_000 }
        );
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- ATR 指标 -----------------------------------------------------------
  server.tool(
    "forex_get_atr",
    "计算 ATR（平均真实波幅），衡量市场波动程度，常用于设置止损/止盈距离。",
    {
      symbol: z.string().optional().default("XAU/USD").describe("标的"),
      interval: z.enum(["1min", "5min", "15min", "30min", "45min", "1h", "2h", "4h", "1day", "1week", "1month"]).optional().default("1day").describe("K线周期"),
      time_period: z.number().int().min(1).max(500).optional().default(14).describe("周期"),
      outputsize: z.number().int().min(1).max(500).optional().default(20).describe("返回条数"),
      timezone: z.string().optional().default("UTC").describe("时区"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(
          env,
          "/atr",
          {
            symbol: normalizeSymbol(args.symbol ?? "XAU/USD"),
            interval: args.interval ?? "1day",
            time_period: String(args.time_period ?? 14),
            outputsize: String(args.outputsize ?? 20),
            timezone: args.timezone ?? "UTC",
          },
          { cacheTtlMs: 60_000 }
        );
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 移动平均指标 ---------------------------------------------------------
  server.tool(
    "forex_get_ma",
    "计算移动均线，支持 SMA(简单)、EMA(指数)、WMA(加权)、DEMA(双重指数)。用于均线买卖信号。",
    {
      symbol: z.string().optional().default("XAU/USD").describe("标的"),
      type: z.enum(["sma", "ema", "wma", "dema"]).optional().default("sma").describe("均线类型：sma/ema/wma/dema"),
      interval: z.enum(["1min", "5min", "15min", "30min", "45min", "1h", "2h", "4h", "1day", "1week", "1month"]).optional().default("1day").describe("K线周期"),
      time_period: z.number().int().min(1).max(500).optional().default(20).describe("周期"),
      outputsize: z.number().int().min(1).max(500).optional().default(20).describe("返回条数"),
      timezone: z.string().optional().default("UTC").describe("时区"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(
          env,
          `/${args.type ?? "sma"}`,
          {
            symbol: normalizeSymbol(args.symbol ?? "XAU/USD"),
            interval: args.interval ?? "1day",
            time_period: String(args.time_period ?? 20),
            outputsize: String(args.outputsize ?? 20),
            timezone: args.timezone ?? "UTC",
          },
          { cacheTtlMs: 60_000 }
        );
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 综合技术分析（一次聚合多个指标） -------------------------------------
  server.tool(
    "forex_get_technical_summary",
    "综合技术分析：一次返回目标在指定周期下 RSI、MACD、布林带、ATR、SMA/MA 等多个指标。基于缓存，后续相同调用不重复消耗额度。适合快速评估做单方向。",
    {
      symbol: z.string().optional().default("XAU/USD").describe("标的，如 XAU/USD、EUR/USD、BTC/USD"),
      interval: z.enum(["1min", "5min", "15min", "30min", "45min", "1h", "2h", "4h", "1day", "1week", "1month"]).optional().default("1day").describe("K线周期"),
      time_period: z.number().int().min(1).max(500).optional().default(14).describe("回看周期（适用于 RSI/布林带/ATR）"),
      indicators: z.array(z.enum(["rsi", "macd", "bollinger", "atr", "ma"])).optional().describe("需要哪些指标，默认全部五个"),
      timezone: z.string().optional().default("UTC").describe("时区"),
    },
    async (args) => {
      const sym = normalizeSymbol(args.symbol ?? "XAU/USD")
      const interval = args.interval ?? "1day"
      const tp = String(args.time_period ?? 14)
      const tz = args.timezone ?? "UTC"
      const wanted = args.indicators?.length ? args.indicators : ["rsi", "macd", "bollinger", "atr", "ma"] as const
      try {
        const calls: Promise<{ id: string; data: any }>[] = []
        if (wanted.includes("rsi"))
          calls.push(callTwelveData(env, "/rsi", { symbol: sym, interval, time_period: tp, outputsize: "10", timezone: tz }, { cacheTtlMs: 60_000 }).then((r) => ({ id: "rsi", data: r.data })))
        if (wanted.includes("macd"))
          calls.push(callTwelveData(env, "/macd", { symbol: sym, interval, fast: "12", slow: "26", signal: "9", outputsize: "10", timezone: tz }, { cacheTtlMs: 60_000 }).then((r) => ({ id: "macd", data: r.data })))
        if (wanted.includes("bollinger"))
          calls.push(callTwelveData(env, "/bbands", { symbol: sym, interval, time_period: tp, stddev: "2", outputsize: "10", timezone: tz }, { cacheTtlMs: 60_000 }).then((r) => ({ id: "bollinger", data: r.data })))
        if (wanted.includes("atr"))
          calls.push(callTwelveData(env, "/atr", { symbol: sym, interval, time_period: tp, outputsize: "10", timezone: tz }, { cacheTtlMs: 60_000 }).then((r) => ({ id: "atr", data: r.data })))
        if (wanted.includes("ma"))
          calls.push(callTwelveData(env, "/sma", { symbol: sym, interval, time_period: tp, outputsize: "5", timezone: tz }, { cacheTtlMs: 60_000 }).then((r) => ({ id: "ma_sma", data: r.data })))

        const results = await Promise.all(calls)
        const summary: Record<string, any> = { symbol: sym, interval, generatedAt: new Date().toISOString() }
        for (const r of results) summary[r.id] = r.data
        return out(JSON.stringify(summary, null, 2))
      } catch (e: any) {
        return out(`综合技术分析失败：${e?.message || String(e)}`, true)
      }
    }
  );

  // -- 符号搜索 -----------------------------------------------------------
  server.tool(
    "forex_symbol_search",
    "按关键字搜索 Twelve Data 支持的外汇/股票符号。",
    {
      symbol: z.string().default("EUR").describe("搜索关键字，如 EUR"),
    },
    async (args) => {
      try {
        const r = await callTwelveData(env, "/symbol_search", { symbol: String(args.symbol ?? "EUR") }, { cacheTtlMs: 120_000 });
        return out(JSON.stringify(r.data, null, 2));
      } catch (e: any) {
        return out(`执行失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- 列出 Keys ----------------------------------------------------------
  server.tool(
    "forex_list_keys",
    "列出当前配置的 Twelve Data API Key（脱敏显示）。",
    {},
    async () => {
      const keys = await getKeys(env);
      const view = keys.map((k) => ({ key: maskKey(k.key), enabled: k.enabled, note: k.note || null, addedAt: k.addedAt }));
      return out(JSON.stringify(view, null, 2));
    }
  );

  // -- 添加 Key -----------------------------------------------------------
  server.tool(
    "forex_add_key",
    "添加一个 Twelve Data API Key。",
    {
      key: z.string().describe("完整 API Key"),
      note: z.string().optional().describe("备注，选填"),
    },
    async (args) => {
      const added = await addKey(env, String(args.key), args.note);
      if (!added) return out("添加失败：key 不能为空", true);
      const total = (await getKeys(env)).length;
      return out(`已添加 key=${maskKey(added.key)}（当前共 ${total} 个）`);
    }
  );

  // -- 删除 Key -----------------------------------------------------------
  server.tool(
    "forex_remove_key",
    "删除一个 Twelve Data API Key。",
    {
      key: z.string().describe("要删除的完整 API Key"),
    },
    async (args) => {
      const ok = await removeKey(env, String(args.key));
      if (!ok) return out("删除失败：未找到该 key", true);
      const total = (await getKeys(env)).length;
      return out(`已删除，剩余 ${total} 个`);
    }
  );

  // -- 启用/禁用 Key ------------------------------------------------------
  server.tool(
    "forex_toggle_key",
    "启用/禁用某个 Twelve Data API Key。",
    {
      key: z.string().describe("完整 API Key"),
      enabled: z.boolean().describe("是否启用"),
    },
    async (args) => {
      const upd = await toggleKey(env, String(args.key), !!args.enabled);
      if (!upd) return out("操作失败：未找到该 key", true);
      return out(`key=${maskKey(upd.key)} 已${upd.enabled ? "启用" : "禁用"}`);
    }
  );

  // -- 检测 Key -----------------------------------------------------------
  server.tool(
    "forex_test_key",
    "即时检测某个 Twelve Data API Key 是否可用（会消耗 1 个请求额度）。",
    {
      key: z.string().describe("要检测的完整 API Key"),
    },
    async (args) => {
      const r = await testKey(env, String(args.key));
      return r.ok ? out(`检测结果：${r.message}`) : out(`检测失败：${r.message}`, true);
    }
  );

  // -- 财经新闻（免费 RSS 聚合） ----------------------------------------------
  server.tool(
    "news_get_headlines",
    `获取免费财经新闻聚合头条。内置源：${FREE_SOURCES.map((source) => `${source.id}(${source.name})`).join('、')}。支持常用中文财经关键词映射、跨源去重和按发布时间倒序，无需额外新闻 API key。`,
    {
      sources: z.array(z.string()).optional().describe(`按源 id 过滤，可选：${FREE_SOURCES.map((s) => s.id).join(', ')}。留空则全部`),
      keyword: z.string().optional().describe("按标题/摘要过滤，支持 gold、fed 以及黄金、美联储、非农、原油等常用中文词"),
      limit: z.number().int().min(1).max(60).optional().default(20).describe("返回条数"),
    },
    async (args) => {
      try {
        const items = await fetchAllNews(env, {
          sources: args.sources as any,
          keyword: args.keyword as any,
          limit: args.limit ?? 20,
        });
        return out(JSON.stringify(items, null, 2));
      } catch (e: any) {
        return out(`获取新闻失败：${e?.message || String(e)}`, true);
      }
    }
  );

  // -- Tavily 搜索（需配置 tavily-proxy） ------------------------------------
  server.tool(
    "news_search_tavily",
    "通过 tavily-proxy 执行联网/新闻搜索。在管理页面(配置- Tavily 搜索代理)填写 URL 与 Auth Key 后即可用。适合查 RSS 覆盖不到的实时新闻与深度调研。",
    {
      query: z.string().describe("搜索查询"),
      max_results: z.number().int().min(1).max(20).optional().default(5).describe("返回结果数"),
      time_range: z.enum(["day", "week", "month", "year"]).optional().describe("时间范围过滤"),
    },
    async (args) => {
      try {
        const result = await searchViaTavily(env, {
          query: String(args.query),
          max_results: args.max_results ?? 5,
          time_range: args.time_range as any,
        });
        return out(JSON.stringify(result, null, 2));
      } catch (e: any) {
        return out(`Tavily 搜索失败：${e?.message || String(e)}`, true);
      }
    }
  );

  return server;
}
