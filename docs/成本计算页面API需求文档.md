# 成本计算页面 API 需求文档

## 概述

成本计算器页面（`calculator.html`）需要调用后端 API 实现完整的成本计算、对比和供应商信息展示功能。

---

## 已有接口（已有，需确认字段）

### 1. GET /api/models

**当前状态**：已有 ✅

**需要确认的字段**：
```json
{
  "pricing": {
    "input_price_per_1m_tokens": 3.0,
    "output_price_per_1m_tokens": 15.0,
    "cached_input_price_per_1m_tokens": 0.75,
    "currency": "USD"
  }
}
```

**确认问题**：
- 是否所有模型都有 `cached_input_price_per_1m_tokens` 字段？
- 如果没有缓存定价，该字段是否存在？值为 `null` 还是不存在该 key？

---

### 2. GET /api/exchange-rate

**当前状态**：已有 ✅

**响应格式确认**：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "base": "USD",
    "rates": {
      "CNY": 7.25,
      "EUR": 0.92,
      "JPY": 149.5,
      "GBP": 0.79,
      "USD": 1.0
    },
    "updated_at": "2026-04-26"
  }
}
```

---

## 需要新增的接口

### 3. POST /api/cost/calculate

**用途**：精确计算单个模型的成本

**请求体**：
```json
{
  "model_id": "gpt-4o",
  "input_tokens": 4096,
  "output_tokens": 1024,
  "requests_per_day": 50000,
  "use_cached_input": false
}
```

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model_id` | string | 是 | 模型ID |
| `input_tokens` | number | 是 | 单次请求平均输入 token 数 |
| `output_tokens` | number | 是 | 单次请求平均输出 token 数 |
| `requests_per_day` | number | 是 | 每日请求数 |
| `use_cached_input` | boolean | 否 | 是否使用缓存输入定价，默认 false |

**响应格式**：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "model_id": "gpt-4o",
    "model_name": "GPT-4o",
    "provider": "openai",
    "daily_cost": {
      "input": 614.40,
      "output": 768.00,
      "total": 1382.40
    },
    "monthly_cost": {
      "input": 18432.00,
      "output": 23040.00,
      "total": 41472.00
    },
    "pricing_used": {
      "input_price_per_1m": 3.0,
      "output_price_per_1m": 15.0,
      "cached_input_price_per_1m": null
    },
    "currency": "USD"
  }
}
```

**计算逻辑**：
- 日输入成本 = `input_tokens * requests_per_day / 1000000 * input_price_per_1m_tokens`
- 日输出成本 = `output_tokens * requests_per_day / 1000000 * output_price_per_1m_tokens`
- 月成本 = 日成本 * 30

**错误响应**：
```json
{
  "code": 404,
  "message": "Model not found",
  "data": null
}
```

```json
{
  "code": 400,
  "message": "Invalid parameters: input_tokens must be >= 0",
  "data": null
}
```

---

### 4. POST /api/cost/compare

**用途**：批量对比多个模型的成本

**请求体**：
```json
{
  "model_ids": ["gpt-4o", "claude-sonnet-4-20250514", "qwen-max"],
  "input_tokens": 4096,
  "output_tokens": 1024,
  "requests_per_day": 50000,
  "use_cached_input": false,
  "sort_by": "total"
}
```

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model_ids` | string[] | 是 | 模型ID数组，最多10个 |
| `input_tokens` | number | 是 | 单次请求平均输入 token 数 |
| `output_tokens` | number | 是 | 单次请求平均输出 token 数 |
| `requests_per_day` | number | 是 | 每日请求数 |
| `use_cached_input` | boolean | 否 | 是否使用缓存输入定价 |
| `sort_by` | string | 否 | 排序字段：`total`(默认)/`input`/`output`/`score` |

**响应格式**：
```json
{
  "code": 200,
  "message": "success",
  "data": [
    {
      "model_id": "gpt-4o",
      "model_name": "GPT-4o",
      "provider": "openai",
      "overall_score": 82.7,
      "monthly_cost": {
        "input": 18432.00,
        "output": 23040.00,
        "total": 41472.00
      },
      "cost_per_1k_tokens": {
        "input": 0.003,
        "output": 0.015
      }
    }
  ],
  "meta": {
    "cheapest_model_id": "qwen-max",
    "cheapest_monthly_cost": 12500.00,
    "most_expensive_model_id": "gpt-4o",
    "most_expensive_monthly_cost": 41472.00,
    "savings_vs_most_expensive": "69.9%"
  }
}
```

**错误响应**：
```json
{
  "code": 400,
  "message": "Too many models: maximum is 10",
  "data": null
}
```

---

### 5. GET /api/providers

**用途**：获取供应商信息（用于展示供应商 Logo）

**当前状态**：已有 ✅ 但字段可能不全

**期望响应**：
```json
{
  "code": 200,
  "message": "success",
  "data": [
    {
      "provider": "openai",
      "name": "OpenAI",
      "name_cn": "OpenAI",
      "logo_url": "https://example.com/logos/openai.svg",
      "model_count": 8,
      "website": "https://openai.com"
    },
    {
      "provider": "anthropic",
      "name": "Anthropic",
      "name_cn": "Anthropic",
      "logo_url": "https://example.com/logos/anthropic.svg",
      "model_count": 5,
      "website": "https://anthropic.com"
    },
    {
      "provider": "aliyun",
      "name": "Alibaba Cloud",
      "name_cn": "阿里云",
      "logo_url": "https://example.com/logos/aliyun.svg",
      "model_count": 4,
      "website": "https://www.aliyun.com"
    }
  ]
}
```

**前端需要的字段**：
- `logo_url`：供应商 Logo URL（SVG 或 PNG，建议透明背景，尺寸 64x64）
- 如果暂时没有 Logo 资源，该字段可以返回空字符串 `""`，前端会用首字母代替

---

## 问题清单（需要 API 端回复）

1. `GET /api/models` 返回的模型中，`pricing` 是否都包含 `cached_input_price_per_1m_tokens`？
2. 是否所有模型都有 `scores.overall_score`？部分模型为 `null` 还是不存在该字段？
3. `GET /api/providers` 目前是否返回 `logo_url` 字段？如果没有，何时可以补充？
4. 供应商列表是否完整？目前模型数据中有 openai、anthropic、aliyun，是否还有其他供应商？
5. 新增的 `POST /api/cost/calculate` 和 `POST /api/cost/compare` 何时可以上线？
