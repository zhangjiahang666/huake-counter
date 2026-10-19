#!/usr/bin/env python3
"""check_links.py — 校验一组 HTML 页面之间的链接完整性。

扫描指定目录（默认当前目录）下所有 .html 文件，提取其中的
href / src 属性，检查指向本地文件的引用是否真实存在，报告断链。

用法:
    python3 check_links.py [目录] [--quiet]

输出:
    - 无断链时打印汇总并退出码 0
    - 有断链时逐条列出 页面 -> 失效链接，退出码 1
"""

import argparse
import os
import re
import sys
from urllib.parse import unquote, urlparse

LINK_RE = re.compile(r"""(?:href|src)\s*=\s*["']([^"']+)["']""", re.IGNORECASE)

# 不以这些前缀开头的链接视为本地文件引用
EXTERNAL_PREFIXES = (
    "http://",
    "https://",
    "//",
    "mailto:",
    "tel:",
    "javascript:",
    "data:",
    "#",
)


def collect_html_files(root: str) -> list[str]:
    """递归收集目录下所有 .html / .htm 文件。"""
    found: list[str] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith((".html", ".htm")):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def extract_links(html_path: str) -> list[str]:
    """提取单个 HTML 文件中的所有 href/src 链接。"""
    with open(html_path, encoding="utf-8", errors="replace") as f:
        content = f.read()
    return LINK_RE.findall(content)


def resolve_target(html_path: str, link: str) -> str | None:
    """把链接解析为本地文件绝对路径；若指向外部/锚点/协议，返回 None。"""
    link = link.strip()
    if not link or link.startswith(EXTERNAL_PREFIXES):
        return None
    # 去掉 fragment（#xxx 定位同一页面内部）
    path_part = urlparse(link).path
    if not path_part:
        return None
    path_part = unquote(path_part)
    return os.path.normpath(os.path.join(os.path.dirname(html_path), path_part))


def main() -> int:
    parser = argparse.ArgumentParser(description="校验一组 HTML 页面的链接完整性")
    parser.add_argument("directory", nargs="?", default=".",
                        help="要扫描的目录（默认当前目录）")
    parser.add_argument("--quiet", action="store_true",
                        help="无断链时不输出汇总信息")
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        print(f"错误：目录不存在或不是目录：{args.directory}", file=sys.stderr)
        return 2

    html_files = collect_html_files(args.directory)
    if not html_files:
        print(f"在 {args.directory} 下未找到任何 .html 文件", file=sys.stderr)
        return 2

    broken: list[tuple[str, str]] = []
    for html_path in html_files:
        for link in extract_links(html_path):
            target = resolve_target(html_path, link)
            if target is not None and not os.path.exists(target):
                broken.append((html_path, link))

    if broken:
        print(f"发现 {len(broken)} 个失效链接（共扫描 {len(html_files)} 个页面）：")
        for page, link in broken:
            print(f"  {os.path.relpath(page, args.directory)} -> {link}")
        return 1

    if not args.quiet:
        print(f"链接检查通过：{len(html_files)} 个页面，所有本地引用均有效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
