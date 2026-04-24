#!/usr/bin/env python3
"""
AIX未来视野 - 数据抓取脚本
数据源: superclueai.com (网页抓取)
使用 requests + BeautifulSoup (静态HTML)
"""

import json
import re
import shutil
import sys
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
MODELS_FILE = DATA_DIR / "models.json"
BACKUP_FILE = DATA_DIR / "models_backup.json"

SUPERCLUE_URL = "https://www.superclueai.com/generalpage"
TIMEOUT = 30

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

VENDOR_LANG_MAP = {
    "OpenAI": "多语言",
    "Anthropic": "多语言",
    "Google": "多语言",
    "Meta": "多语言",
    "Mistral": "多语言",
}

CHINESE_VENDORS = [
    "智谱", "百度", "阿里", "字节跳动", "月之暗面", "商汤", "科大讯飞",
    "零一", "清华", "DeepSeek", "出门问问", "OPPO", "佳都", "360",
    "百川", "稀宇", "元象", "智谱AI", "阿里巴巴",
]

OPEN_SOURCE_VENDORS = ["Meta", "清华", "阿里巴巴", "零一", "百川", "元象", "yiming cui", "佳都科技"]


def infer_languages(vendor):
    for v, lang in VENDOR_LANG_MAP.items():
        if v in vendor:
            return lang
    if any(v in vendor for v in CHINESE_VENDORS):
        return "中文/英文"
    return "多语言"


def infer_type(vendor):
    if any(v in vendor for v in OPEN_SOURCE_VENDORS):
        return "开源"
    return "闭源"


def clean_rank(text):
    text = re.sub(r'[🏅️🥈]', '', text).strip()
    return text


def is_valid_number(text):
    try:
        float(text)
        return True
    except (ValueError, TypeError):
        return False


def extract_models_from_text(text_content):
    """从页面文本中提取表格数据"""
    models = []
    lines = text_content.split('\n')

    for i, line in enumerate(lines):
        if '|' not in line:
            continue

        cells = [c.strip() for c in line.split('|')]
        cells = [c for c in cells if c]

        if len(cells) < 4:
            continue

        rank_text = clean_rank(cells[0])

        if rank_text == '-':
            continue

        if '排名' in rank_text:
            continue

        if ':-' in rank_text or '---' in rank_text:
            continue

        if not is_valid_number(rank_text):
            continue

        name = cells[1].strip()
        vendor = cells[2].strip()
        score_text = cells[3].strip()

        if not name or not vendor:
            continue

        if not is_valid_number(score_text):
            continue

        score = float(score_text)

        special = '-'
        if len(cells) > 4:
            usage = cells[-1].strip()
            if usage in ['API', '网页', '模型']:
                special = '-'
            else:
                special = usage

        models.append({
            "name": name,
            "vendor": vendor,
            "type": infer_type(vendor),
            "languages": infer_languages(vendor),
            "score": score,
            "special": special,
        })

    return models


def fetch_superclue_data():
    """从 superclueai.com 获取数据"""
    print(f"[INFO] 尝试从 {SUPERCLUE_URL} 获取数据...")
    try:
        resp = requests.get(SUPERCLUE_URL, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # 尝试提取页面中的文本内容
        text_content = soup.get_text(separator='\n', strip=True)
        return text_content
    except Exception as e:
        print(f"[WARN] superclueai.com 获取失败: {e}")
    return None


def fetch_from_gitee():
    """从 Gitee 获取数据"""
    gitee_url = "https://gitee.com/mirrors/SuperCLUE"
    print(f"[INFO] 尝试从 {gitee_url} 获取数据...")
    try:
        resp = requests.get(gitee_url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        text_content = soup.get_text(separator='\n', strip=True)
        return text_content
    except Exception as e:
        print(f"[WARN] Gitee 获取失败: {e}")
    return None


def load_existing_data():
    if MODELS_FILE.exists():
        with open(MODELS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def backup_existing_data():
    if MODELS_FILE.exists():
        shutil.copy2(MODELS_FILE, BACKUP_FILE)
        print(f"[OK] 已备份旧数据 -> {BACKUP_FILE}")


def save_data(models):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(models, f, ensure_ascii=False, indent=2)


def main():
    print("AIX未来视野 - 数据抓取 (SuperCLUE)")

    backup_existing_data()

    content = None

    content = fetch_superclue_data()
    if not content:
        content = fetch_from_gitee()

    if not content:
        print("[ERROR] 无法获取任何数据源")
        existing = load_existing_data()
        if existing:
            print("[INFO] 使用上次数据")
            save_data(existing)
        else:
            print("[ERROR] 无数据可用")
            sys.exit(1)
        return

    models = extract_models_from_text(content)

    if not models:
        print("[WARN] 未解析到数据，使用上次数据")
        existing = load_existing_data()
        if existing:
            save_data(existing)
        else:
            print("[ERROR] 无数据")
            sys.exit(1)
        return

    seen = {}
    for m in models:
        key = m.get("name", "").strip()
        if key and key not in seen:
            seen[key] = m
    unique_models = list(seen.values())

    unique_models.sort(key=lambda x: x.get("score", 0), reverse=True)

    for i, m in enumerate(unique_models):
        m["rank"] = i + 1

    save_data(unique_models)
    print(f"[OK] 抓取完成: {len(unique_models)} 条模型")
    print(f"[OK] 数据已保存至 {MODELS_FILE}")

    print("\n排名前5:")
    for m in unique_models[:5]:
        print(f"  #{m['rank']} {m['name']} ({m['vendor']}) - 评分: {m['score']}")


if __name__ == "__main__":
    main()
