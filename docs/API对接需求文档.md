# AIX未来视野 - 前端对接现有 API 需求文档

## 概述

API 端（`https://aixfutureapi.vercel.app`）已有以下 9 个接口，本文档基于**实际测试**整理各接口的请求/响应格式，用于前端对接。

---

## 现有接口总览

| 方法 | 路径 | 说明 | 状态 |
|------|------|------|------|
| GET | `/` | 根路径 | ✅ 有数据 |
| GET | `/api/models` | 获取模型列表 | ✅ 有数据（15条） |
| GET | `/api/models/{model_id}` | 获取单个模型 | ✅ 有数据 |
| GET | `/api/compare` | 模型对比 | ✅ 有数据 |
| GET | `/api/providers` | 供应商列表 | ✅ 有数据（7个） |
| POST | `/api/cost/calculate` | 成本计算 | ⚠️ 需确认参数 |
| POST | `/api/cost/compare` | 成本对比 | ⚠️ 需确认参数 |
| GET | `/api/search` | 搜索模型 | ✅ 有数据 |
| GET | `/api/status` | 服务状态 | ✅ 有数据 |

---

## 接口详情

### 1. GET /api/models

**用途**：模型库页面列表数据

**查询参数**（待确认）：
- 是否支持 `provider` 筛选？
- 是否支持 `type` 筛选？
- 是否支持 `access` 筛选？
- 是否支持 `page`/`pageSize` 分页？

**实际响应**：
```json
[
  {
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
    "logo_url": "",
    "website_url": "https://platform.openai.com/docs/models/gpt-4o",
    "release_date": "2024-05-13",
    "input_price": 0.005,
    "output_price": 0.015,
    "cached_input_price": 0.00125,
    "currency": "USD",
    "price_unit": "1K tokens"
  }
]
```

**前端需要的补充字段**：
- `capabilities`（能力标签：text/image/audio/video/function_calling/streaming）
- `created_at` / `updated_at`

---

### 2. GET /api/models/{model_id}

**用途**：模型详情页

**实际响应**（id=1）：
```json
{
  "id": 1,
  "name": "GPT-4o",
  "provider": "OpenAI",
  ...
}
```

---

### 3. GET /api/compare

**用途**：模型对比功能（成本计算页面用）

**查询参数**：`model_ids`（逗号分隔，如 `1,2,3`）

**实际响应**：
```json
[
  {
    "id": 1,
    "name": "GPT-4o",
    "provider": "OpenAI",
    "input_price": 0.005,
    "output_price": 0.015,
    "cached_input_price": 0.00125,
    ...
  }
]
```

---

### 4. GET /api/providers

**用途**：模型库侧边栏供应商筛选器

**实际响应**：
```json
[
  {
    "key": "openai",
    "name": "OpenAI",
    "name_cn": "OpenAI",
    "logo_url": "",
    "model_count": 3,
    "website": "https://openai.com"
  },
  {
    "key": "anthropic",
    "name": "Anthropic",
    "name_cn": "Anthropic",
    "logo_url": "",
    "model_count": 2,
    "website": "https://anthropic.com"
  }
]
```

**问题**：
- 目前只有 7 个供应商，实际模型数据中有更多（如 阿里巴巴、月之暗面、深度求索等），需要补充

---

### 5. GET /api/search

**用途**：模型库搜索功能

**查询参数**：`q`（关键词）

**实际响应**：
```json
[
  {
    "id": 1,
    "name": "GPT-4o",
    "provider": "OpenAI",
    "type": "多模态",
    "access": "闭源",
    "tags": ["多模态", "128K 上下文", "闭源"],
    ...
  }
]
```

---

### 6. GET /api/status

**用途**：服务健康检查

**实际响应**：
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "model_count": 15,
  "provider_count": 7,
  "last_updated": "2026-04-25T12:00:00Z"
}
```

---

### 7. POST /api/cost/calculate

**用途**：成本计算（成本计算页面核心接口）

**请求体**：
```json
{
  "model_id": "string",
  "input_tokens": 1000,
  "output_tokens": 1000
}
```

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model_id` | string | 是 | 模型 ID（字符串类型） |
| `input_tokens` | number | 是 | 输入 token 数量 |
| `output_tokens` | number | 是 | 输出 token 数量 |

**待确认**：
- 返回格式是什么？是否包含 USD/CNY 双币种？
- 是否支持 `quantity`（调用次数）参数？
- 是否支持 `currency` 参数？
- 是否支持缓存 token 计算（`cached_tokens`）？

---

### 8. POST /api/cost/compare

**用途**：多模型成本对比

**请求体**：
```json
{
  "models": ["string"],
  "input_tokens": 1000,
  "output_tokens": 1000
}
```

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `models` | string[] | 是 | 模型 ID 数组（字符串类型） |
| `input_tokens` | number | 是 | 输入 token 数量 |
| `output_tokens` | number | 是 | 输出 token 数量 |

**待确认**：
- 返回格式是什么？是否包含最便宜/最贵模型标识？
- `models` 数组中的元素是 model_id 还是 model_name？

---

## 前端需要 API 端补充/完善的事项

### 高优先级（影响核心功能）

1. **模型列表筛选参数**
   - `GET /api/models` 需要支持 `?provider=xxx&type=xxx&access=xxx` 查询参数
   - 或者前端用 `GET /api/search` 替代筛选

2. **供应商数据不完整**
   - 当前只有 7 个供应商，但模型数据中包含：阿里巴巴、月之暗面、深度求索、智谱AI、Mistral AI、Stability AI
   - 需要补充这些供应商到 `/api/providers`

3. **成本计算接口参数确认**
   - `POST /api/cost/calculate` 的请求体和响应格式需要明确文档

4. **成本对比接口参数确认**
   - `POST /api/cost/compare` 的请求体和响应格式需要明确文档

5. **汇率接口**
   - 前端需要 USD ↔ CNY 汇率
   - 可以硬编码在后端，或接入第三方 API
   - 建议新增 `GET /api/exchange-rate` 接口

### 中优先级（增强体验）

6. **模型能力字段**
   - 建议给模型增加 `capabilities` 字段：
   ```json
   "capabilities": {
     "text": true,
     "image": true,
     "audio": true,
     "video": false,
     "function_calling": true,
     "streaming": true
   }
   ```

7. **模型分类/标签筛选**
   - 前端侧边栏有"模型类型"筛选（大语言模型、多模态、视觉、音频）
   - 建议新增 `GET /api/model-types` 返回类型列表

8. **分页支持**
   - 当模型数量增多后，`/api/models` 需要支持 `?page=1&pageSize=20`

### 低优先级（可选）

9. **排行榜接口**
   - 当前排行榜数据是静态 JSON
   - 如需 API 化，新增 `GET /api/leaderboards`

10. **Logo 图片**
    - 供应商 `logo_url` 当前为空
    - 建议补充 Logo 资源地址

---

## 前端对接计划

### Phase 1：模型库页面对接
- [ ] `GET /api/models` → 替换当前 mock 数据
- [ ] `GET /api/providers` → 侧边栏供应商筛选
- [ ] `GET /api/search` → 搜索功能
- [ ] `GET /api/models/:id` → 模型详情弹窗

### Phase 2：成本计算页面对接
- [ ] `GET /api/models` → 展示所有模型定价
- [ ] `POST /api/cost/calculate` → 单个模型成本计算
- [ ] `POST /api/cost/compare` → 多模型成本对比
- [ ] `GET /api/exchange-rate` → 汇率展示（需新增）

### Phase 3：优化
- [ ] 模型列表筛选参数支持
- [ ] 分页
- [ ] 供应商 Logo

---

## 需要 API 端回复的问题

1. `POST /api/cost/calculate` 的请求体格式是什么？能否提供示例？
2. `POST /api/cost/compare` 的请求体格式是什么？能否提供示例？
3. `GET /api/models` 是否支持 `provider`、`type`、`access` 筛选参数？
4. 是否有汇率数据？如果没有，是否需要我前端硬编码汇率？
5. 供应商数据能否补充完整（阿里巴巴、月之暗面等）？
6. Swagger 文档页面加载失败（`/openapi.json` 404），能否修复？
