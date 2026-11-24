#!/usr/bin/env bash
# 跑全部离线校验；缺 DSH 安装或缺 jev 后端时对应套件自动跳过，不算失败。
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0

echo "== dual-mirror"
(cd dual-mirror && node test/verify.mjs) || fail=1

echo "== acp-pool"
(cd acp-pool && node --test test/*.test.mjs) || fail=1

echo "== jev-supervisor"
(cd jev-supervisor && node --test test/*.test.mjs) || fail=1

if [ "$fail" -eq 0 ]; then printf "\n全部通过 ✅\n"; else printf "\n有套件失败 ❌\n"; fi
exit "$fail"
