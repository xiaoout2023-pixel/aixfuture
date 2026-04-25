# AIX未来视野 - API 接口需求文档

## 概述

本文档定义了 AIX未来视野 前端项目所需的后端 API 接口，涵盖三大核心功能：
1. **排行榜数据接口** - 替代当前静态 JSON 文件
2. **模型库数据接口** - 替代当前 mock JSON 文件
3. **成本计算器接口** - 全新功能，计算不同模型 API 调用成本

---

## 通用规范

### 基础信息
- **Base URL**: `https://aixfutureapi.vercel.app/api`
- **Content-Type**: `application/json`
- **字符编码**: UTF-8
- **时间格式**: ISO 8601 (`2026-04-25T12:00:00Z`)

### 统一响应格式
```json
{
  "code": 200,
  "message": "success",
  "data": { ... },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### 错误响应格式
```json
{
  "code": 400,
  "message": "参数错误: provider 不能为空",
  "error": "INVALID_PARAM",
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### HTTP 状态码
| 状态码 | 含义 |
|--------|------|
| 200 | 请求成功 |
| 400 | 参数错误 |
| 404 | 资源不存在 |
| 500 | 服务器错误 |

---

## 一、排行榜接口

### 1.1 获取排行榜数据

替代当前 `data/models.json` 的静态数据。

**请求**
```
GET /api/leaderboards
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `board` | string | 否 | 榜单类型：`general`（通用）、`reasoning`（推理）、`open`（开源）。不传则返回全部 |

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "update_time": "2026-04-25",
    "leaderboards": {
      "general": {
        "name": "通用排行榜",
        "models": [
          {
            "rank": 1,
            "name": "Claude-Opus-4.6(max)",
            "vendor": "Anthropic",
            "type": "闭源",
            "languages": "多语言",
            "score": 77.02,
            "math_reasoning": 85.71,
            "hallucination_control": 82.95,
            "science_reasoning": 85.37,
            "instruction_following": 47.57,
            "code_generation": 71.15,
            "agent_planning": 89.35
          }
        ]
      },
      "reasoning": {
        "name": "推理模型总排行榜",
        "models": [ ... ]
      },
      "open": {
        "name": "开源排行榜",
        "models": [ ... ]
      }
    }
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `rank` | number | 排名 |
| `name` | string | 模型名称 |
| `vendor` | string | 厂商/供应商 |
| `type` | string | `闭源` 或 `开源` |
| `languages` | string | 支持语言 |
| `score` | number | 总分（保留2位小数） |
| `math_reasoning` | number | 数学推理分数（百分比，0-100） |
| `hallucination_control` | number | 幻觉控制分数 |
| `science_reasoning` | number | 科学推理分数 |
| `instruction_following` | number | 指令遵循分数 |
| `code_generation` | number | 代码生成分数 |
| `agent_planning` | number | 智能体规划分数 |

---

## 二、模型库接口

### 2.1 获取模型列表

替代当前 `data/models-mock.json` 的静态数据。

**请求**
```
GET /api/models
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `provider` | string | 否 | 按供应商筛选，支持多值 `provider=OpenAI&provider=Anthropic` |
| `type` | string | 否 | 按模型类型筛选：`大语言模型`、`多模态`、`视觉`、`音频` |
| `access` | string | 否 | 按访问方式筛选：`开源`、`闭源` |
| `search` | string | 否 | 搜索关键词（模型名称、供应商、标签） |
| `page` | number | 否 | 页码，默认 1 |
| `pageSize` | number | 否 | 每页数量，默认 20，最大 100 |

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 15,
    "page": 1,
    "pageSize": 20,
    "models": [
      {
        "id": 1,
        "name": "GPT-4o",
        "provider": "OpenAI",
        "provider_name_cn": "OpenAI",
        "type": "多模态",
        "access": "闭源",
        "description": "OpenAI 的旗舰多模态模型，在文本、视觉和音频推理方面实现了革命性的速度和性能提升。",
        "tags": ["多模态", "128K 上下文", "闭源"],
        "context_window": "128K",
        "context_tokens": 128000,
        "logo_url": "https://example.com/logos/openai.png",
        "website_url": "https://platform.openai.com/docs/models/gpt-4o",
        "release_date": "2024-05-13",
        "created_at": "2026-04-01T00:00:00Z",
        "updated_at": "2026-04-25T00:00:00Z"
      }
    ]
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

**新增字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider_name_cn` | string | 供应商中文名 |
| `context_window` | string | 上下文窗口描述，如 `128K` |
| `context_tokens` | number | 上下文窗口 token 数 |
| `logo_url` | string | 供应商 Logo URL |
| `website_url` | string | 模型文档链接 |
| `release_date` | string | 发布日期 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

### 2.2 获取模型详情

**请求**
```
GET /api/models/:id
```

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "name": "GPT-4o",
    "provider": "OpenAI",
    "provider_name_cn": "OpenAI",
    "type": "多模态",
    "access": "闭源",
    "description": "OpenAI 的旗舰多模态模型...",
    "tags": ["多模态", "128K 上下文", "闭源"],
    "context_window": "128K",
    "context_tokens": 128000,
    "logo_url": "https://example.com/logos/openai.png",
    "website_url": "https://platform.openai.com/docs/models/gpt-4o",
    "release_date": "2024-05-13",
    "pricing": {
      "input_price": 0.005,
      "output_price": 0.015,
      "currency": "USD",
      "price_unit": "1K tokens",
      "cached_input_price": 0.00125
    },
    "capabilities": {
      "text": true,
      "image": true,
      "audio": true,
      "video": false,
      "function_calling": true,
      "streaming": true,
      "json_mode": true
    },
    "created_at": "2026-04-01T00:00:00Z",
    "updated_at": "2026-04-25T00:00:00Z"
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### 2.3 获取供应商列表

用于模型库侧边栏筛选器的供应商列表。

**请求**
```
GET /api/providers
```

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "providers": [
      {
        "key": "OpenAI",
        "name_cn": "OpenAI",
        "name_en": "OpenAI",
        "logo_url": "https://example.com/logos/openai.png",
        "model_count": 5,
        "website": "https://openai.com"
      },
      {
        "key": "Anthropic",
        "name_cn": "Anthropic",
        "name_en": "Anthropic",
        "logo_url": "https://example.com/logos/anthropic.png",
        "model_count": 3,
        "website": "https://anthropic.com"
      }
    ]
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### 2.4 获取模型类型列表

**请求**
```
GET /api/model-types
```

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "types": [
      {
        "key": "大语言模型",
        "name": "大语言模型",
        "icon": "language",
        "count": 8
      },
      {
        "key": "多模态",
        "name": "多模态",
        "icon": "view_in_ar",
        "count": 4
      }
    ]
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

---

## 三、成本计算器接口（核心新功能）

### 3.1 获取模型定价信息

获取指定模型的 API 调用价格。

**请求**
```
GET /api/pricing/:modelId
```

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "model_id": 1,
    "model_name": "GPT-4o",
    "provider": "OpenAI",
    "pricing": {
      "input_price": 0.005,
      "output_price": 0.015,
      "cached_input_price": 0.00125,
      "currency": "USD",
      "price_unit": "1K tokens"
    }
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

**定价字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `input_price` | number | 输入 token 价格（每 1K tokens，美元） |
| `output_price` | number | 输出 token 价格（每 1K tokens，美元） |
| `cached_input_price` | number | 缓存输入 token 价格（如有，每 1K tokens） |
| `currency` | string | 货币单位，默认 `USD` |
| `price_unit` | string | 价格单位，默认 `1K tokens` |

### 3.2 成本计算

**核心接口**：根据用户输入的参数计算 API 调用预估成本。

**请求**
```
POST /api/calculate
```

**请求体**
```json
{
  "model_id": 1,
  "input_tokens": 5000,
  "output_tokens": 1000,
  "use_cache": false,
  "cached_tokens": 0,
  "quantity": 1,
  "currency": "CNY"
}
```

**请求参数说明**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model_id` | number | 是 | 模型 ID |
| `input_tokens` | number | 是 | 输入 token 数量 |
| `output_tokens` | number | 是 | 输出 token 数量 |
| `use_cache` | boolean | 否 | 是否使用缓存，默认 `false` |
| `cached_tokens` | number | 否 | 缓存 token 数量，默认 `0` |
| `quantity` | number | 否 | 调用次数，默认 `1` |
| `currency` | string | 否 | 货币：`USD`、`CNY`。默认 `CNY` |

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "model_id": 1,
    "model_name": "GPT-4o",
    "provider": "OpenAI",
    "calculation": {
      "input_cost": 0.025,
      "output_cost": 0.015,
      "cached_input_cost": 0,
      "total_cost_usd": 0.04,
      "total_cost_cny": 0.29,
      "quantity": 1,
      "total_for_quantity_usd": 0.04,
      "total_for_quantity_cny": 0.29,
      "exchange_rate": 7.25,
      "currency": "CNY"
    },
    "breakdown": [
      {
        "item": "输入 token",
        "tokens": 5000,
        "unit_price_usd": 0.005,
        "cost_usd": 0.025
      },
      {
        "item": "输出 token",
        "tokens": 1000,
        "unit_price_usd": 0.015,
        "cost_usd": 0.015
      }
    ]
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

**计算逻辑**
```
输入成本 = input_tokens / 1000 * input_price
输出成本 = output_tokens / 1000 * output_price
缓存成本 = cached_tokens / 1000 * cached_input_price（仅当 use_cache=true 时）
总成本（USD）= 输入成本 + 输出成本 + 缓存成本
总成本（CNY）= 总成本（USD）* 汇率
多次调用 = 总成本 * quantity
```

### 3.3 批量成本计算

支持同时计算多个模型的成本，用于模型间成本对比。

**请求**
```
POST /api/calculate/batch
```

**请求体**
```json
{
  "models": [
    { "model_id": 1, "input_tokens": 5000, "output_tokens": 1000 },
    { "model_id": 2, "input_tokens": 5000, "output_tokens": 1000 },
    { "model_id": 3, "input_tokens": 5000, "output_tokens": 1000 }
  ],
  "currency": "CNY"
}
```

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "results": [
      {
        "model_id": 1,
        "model_name": "GPT-4o",
        "provider": "OpenAI",
        "total_cost_cny": 0.29
      },
      {
        "model_id": 2,
        "model_name": "Claude 3.5 Sonnet",
        "provider": "Anthropic",
        "total_cost_cny": 0.22
      },
      {
        "model_id": 3,
        "model_name": "Llama 3 70B",
        "provider": "Meta",
        "total_cost_cny": 0.05
      }
    ],
    "cheapest": {
      "model_id": 3,
      "model_name": "Llama 3 70B",
      "total_cost_cny": 0.05
    },
    "most_expensive": {
      "model_id": 1,
      "model_name": "GPT-4o",
      "total_cost_cny": 0.29
    },
    "currency": "CNY"
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### 3.4 获取汇率

获取当前美元对人民币汇率。

**请求**
```
GET /api/exchange-rate
```

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "base": "USD",
    "target": "CNY",
    "rate": 7.25,
    "updated_at": "2026-04-25T00:00:00Z"
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### 3.5 获取所有模型的定价列表

用于成本计算页面展示所有模型的定价对比表。

**请求**
```
GET /api/pricing
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `provider` | string | 否 | 按供应商筛选 |
| `access` | string | 否 | 按访问方式筛选 |

**响应示例**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "pricing_list": [
      {
        "model_id": 1,
        "model_name": "GPT-4o",
        "provider": "OpenAI",
        "type": "多模态",
        "access": "闭源",
        "input_price": 0.005,
        "output_price": 0.015,
        "cached_input_price": 0.00125,
        "currency": "USD",
        "price_unit": "1K tokens"
      }
    ]
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

---

## 四、数据维护接口（管理端使用）

### 4.1 创建/更新模型

**请求**
```
POST /api/admin/models
```

**请求体**
```json
{
  "name": "GPT-4o",
  "provider": "OpenAI",
  "provider_name_cn": "OpenAI",
  "type": "多模态",
  "access": "闭源",
  "description": "模型描述...",
  "tags": ["多模态", "128K 上下文"],
  "context_tokens": 128000,
  "logo_url": "https://...",
  "website_url": "https://...",
  "release_date": "2024-05-13"
}
```

### 4.2 更新模型定价

**请求**
```
PUT /api/admin/pricing/:modelId
```

**请求体**
```json
{
  "input_price": 0.005,
  "output_price": 0.015,
  "cached_input_price": 0.00125
}
```

---

## 五、前端需要的关键数据总结

### 模型库页面需要的数据
1. 模型列表（支持筛选、搜索、分页）
2. 供应商列表（用于侧边栏复选框筛选）
3. 模型类型列表（用于侧边栏标签筛选）
4. 单个模型详情（点击卡片后展示）

### 成本计算页面需要的数据
1. 所有模型的定价列表（展示定价对比表）
2. 单个模型定价详情
3. 汇率（USD ↔ CNY）
4. 成本计算接口（输入参数 → 返回费用）
5. 批量成本计算（模型对比）

### 排行榜页面需要的数据
1. 排行榜数据（当前从静态 JSON 读取，建议改为 API）

---

## 六、优先级建议

### Phase 1（必须）
1. `GET /api/models` - 模型库列表
2. `GET /api/providers` - 供应商列表
3. `GET /api/model-types` - 模型类型列表
4. `GET /api/pricing` - 所有模型定价
5. `POST /api/calculate` - 成本计算
6. `GET /api/exchange-rate` - 汇率

### Phase 2（重要）
7. `GET /api/models/:id` - 模型详情
8. `GET /api/pricing/:modelId` - 单个模型定价
9. `POST /api/calculate/batch` - 批量成本计算

### Phase 3（可选）
10. `GET /api/leaderboards` - 排行榜数据（替代静态 JSON）
11. 管理端 CRUD 接口

---

## 七、建议的技术方案

1. **数据存储**: PostgreSQL 或 MongoDB，存储模型信息和定价数据
2. **汇率**: 接入免费汇率 API（如 `exchangerate-api.com`），每日更新
3. **定价数据**: 建议手动维护 + 定期审核，因为各厂商定价变化不频繁
4. **模型信息**: 可结合爬虫自动采集 + 人工校对
5. **CORS**: 确保 API 允许 `https://aixfuture.vercel.app` 跨域访问
