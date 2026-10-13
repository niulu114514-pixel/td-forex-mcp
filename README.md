# TD Forex MCP

基于 Cloudflare Workers 和 Twelve Data 的外汇行情服务。它同时提供 JSON K 线接口、技术指标、新闻与 MCP 工具，并通过 D1 管理 Twelve Data 密钥池和缓存。

## K 线是否实时

网页展示的是 Twelve Data 的最新 OHLC 数据，属于“近实时”而不是交易所逐笔行情：

- 默认允许最多约 60 秒缓存，以减少上游额度消耗。
- 页面可每 60 秒自动刷新，并可手动刷新。
- API 使用 `fresh=1`、MCP 使用 `fresh: true` 可绕过本地缓存并请求上游。
- 实际更新速度仍受 Twelve Data 数据源、品种、时间级别和账户套餐限制。

MCP 可以获取 K 线。`get_time_series` 返回结构化的时间、开盘、最高、最低、收盘和成交量数据；它不会直接返回一张绘制好的蜡烛图图片，MCP 客户端可据此分析或自行绘图。

## 功能

- 外汇实时报价、汇率、交易时段状态和品种列表。
- 多时间级别历史 K 线与强制刷新。
- RSI、MACD、布林带、ATR、均线和技术摘要。
- RSS 新闻与可选 Tavily 新闻搜索。
- Twelve Data 多密钥管理、健康状态、故障切换，以及每个 Key 的分钟/每日真实余额。
- 管理后台、HTTP API 和 MCP Streamable HTTP 入口。

## 技术栈

- Cloudflare Workers + Hono
- Cloudflare D1（绑定名：`DB`）
- Twelve Data API
- Model Context Protocol

## 快速开始

```bash
cd td-forex-mcp
npm install
npx wrangler d1 migrations apply td-forex-mcp --local
npm run dev
```

本地 `.dev.vars`：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为强密码
MARKET_API_KEY=供行情接口和MCP使用的随机密钥
```

启动后进入 `/admin` 添加 Twelve Data API Key。

管理页可单独或批量调用 Twelve Data 官方 `/api_usage` 查询套餐、每分钟和每日额度，并缓存最近一次成功结果。额度查询本身会消耗对应 Key 的 1 个 API credit，因此页面不会自动刷新；批量刷新前也会显示确认提示。

## 部署

新环境需要先创建 D1，并将数据库 ID 写入 `wrangler.toml`：

```bash
npx wrangler d1 create td-forex-mcp
npx wrangler d1 migrations apply td-forex-mcp --remote
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put MARKET_API_KEY
npx wrangler secret put TWELVE_DATA_KEYS
npm run deploy
```

`TWELVE_DATA_KEYS` 仅用于全新数据库首次导入，支持逗号或换行分隔。部署包不再包含 Twelve Data Key；已有 D1 Key 池不会被覆盖。

迁移文件名中的 `kv` 是历史命名，当前实际使用 D1。

## HTTP 接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /` | 健康检查 |
| `GET /admin` | 密钥和服务配置后台 |
| `GET /api/kline` | K 线 JSON 接口 |
| `GET /api/news` | RSS 聚合与可选 Tavily 网页新闻搜索 |
| `POST /mcp` | MCP Streamable HTTP 入口 |

K 线示例：

```bash
curl "https://<你的域名>/api/kline?symbol=EUR/USD&interval=15min&outputsize=200&fresh=1" \
  -H "x-api-key: <MARKET_API_KEY>"
```

新闻接口同样使用 `MARKET_API_KEY` 鉴权，支持 `keyword`、`sources`、`limit` 参数；传入 `deep=1` 与 `time_range=day|week|month|year` 时，会调用管理页中已配置的 Tavily MCP 搜索补充网页新闻。RSS 默认聚合 Federal Reserve、ECB、Bank of England、Oilprice、CNBC 与 ForexLive，支持“黄金 / 美联储 / 非农”等常用中文关键词映射，结果跨来源去重并按发布时间倒序。接口通过 `source_status` 返回每个来源的实时健康状态；抓取失败时可回退到最近一次成功缓存并标记为陈旧数据。

## MCP 工具概览

- 行情：`get_price`、`get_time_series`、外汇报价/汇率/市场状态、品种搜索。
- 指标：RSI、MACD、BBands、ATR、MA、技术摘要。
- 新闻：RSS 与 Tavily 新闻查询。
- 管理：查看、添加、更新和删除 Twelve Data 密钥（需要相应权限）。

客户端通过 `x-api-key`、HTTP Basic 或已登录会话访问受保护接口。`x-api-key` 已在 MCP 鉴权中实际启用，推荐外部 MCP 客户端使用它。

```json
{
  "mcpServers": {
    "td-forex": {
      "type": "streamable-http",
      "url": "https://<你的域名>/mcp",
      "headers": { "x-api-key": "<MARKET_API_KEY>" }
    }
  }
}
```

## 安全与额度

- `fresh` 会增加 Twelve Data 请求次数，只在确实需要最新数据时使用。
- 不要把管理员密码、市场 API Key 或 Twelve Data Key 写进 Git。
- 此服务提供数据工具，不构成投资建议；实盘决策前应核对数据源。
