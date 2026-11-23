# Contributing

这是个个人自用为主的小工具集，欢迎 issue 和 PR，但请先看一眼下面几条，能省彼此时间。

## 提 issue 之前

- 先说清**环境**：DSH 版本、Node 版本、Android 版本（如果涉及 adb-autopair）、是否 rooted/Shizuku。
- 给出**最小复现**：哪条命令、什么输出、期望是什么。报错请贴原文，不要只贴截图。
- 如果是插件加载失败，附上 profile 的 `cordis.patch.yml` 里对应的那一段（脱敏后再贴）。

## 本地怎么跑

```bash
# 纯逻辑单测（任何机器都能跑）
cd acp-pool && node --test test/*.test.mjs

# 依赖本机环境，可能失败
cd dual-mirror && node test/verify.mjs   # 需要本机装有 DSH
cd jev-supervisor && node --test test/*.test.mjs   # 需要本地 jev-supervisor 后端
```

## PR

- 一个 PR 只做一件事，别混格式化。
- 改行为就补测试；改文档不用。
- commit message 用 `fix:` / `feat:` / `docs:` / `chore:` 开头，一句话说清。
- 破坏兼容的改动请先开 issue 讨论。

## 不接受的

- 引入运行时依赖却不说明理由；
- 把个人路径、账号名、密钥写进代码或示例（这个会直接打回）。
