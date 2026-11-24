# 示例输出

`sample-export.md` 是用 `dual-mirror` 的导出函数（`renderMarkdownExport`）对一段对话生成的**真实产物**，不是手写的宣传稿：
它展示的就是插件「导出为 Markdown」时你能拿到的东西——标题、导出说明、按发言方切分的小节。

生成方式（在 `dual-mirror/` 下）：

```js
import { renderMarkdownExport, DEFAULT_SPEAKERS } from './lib/mirror.js'
const md = renderMarkdownExport({ label: 'ACP 额度路由设计', provenance: '示例对话', speakers: DEFAULT_SPEAKERS, messages, createdAt: 1795000000000 })
```

平时在 DSH 里，对话会被写成一条 `subagent/catalog` + 一个子会话；`exportMarkdown()` 是把子会话正文落成 Markdown 的降级路径。
