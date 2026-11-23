/**
 * dsh-acp-pool — 运行时注册多个 ACP provider（一个模型一个），并提供一个自动选模型的委派工具。
 *
 * 背景：`agy --model` 只能在 `acp` 子命令之前指定，所以一个 ACP provider 只能绑定一个模型；
 * 想按任务挑模型就得有多个 provider。这里复用上游 dsh-subagent-acp 的 apply()（ctx.plugin）
 * 注册 provider，再用一个 `acp_delegate` 工具按任务类型 + 额度自动挑，也支持显式指定。
 */
import { buildAcpArgs, normalizeConfig } from './config.js'
import { loadAcpModule } from './modules.js'
import { createQuotaReader } from './quota.js'
import { createRouteReader } from './route.js'
import { availabilityFromSummary, gateDecision, pickProvider, preferGroup } from './select.js'
import { loadDefineTool } from './sdk.js'

export const name = 'dsh-acp-pool'
export const inject = ['subagents', 'tools']

function objectSchema(properties) {
  return { type: 'object', additionalProperties: false, properties }
}

function abortError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console

  if (typeof ctx.plugin !== 'function') {
    throw new Error('[dsh-acp-pool] 当前 DSH 没有 ctx.plugin；cordis 版本不兼容，无法注册子插件')
  }

  const acpModule = await loadAcpModule(config)
  for (const provider of config.providers) {
    if (ctx.subagents.getProvider(provider.name) !== undefined) {
      throw new Error(`[dsh-acp-pool] provider "${provider.name}" 已经存在；请改名或删掉冲突配置`)
    }
    const envKeys = Object.keys(provider.env ?? {})
    await ctx.plugin(acpModule, {
      providerName: provider.name,
      command: config.command,
      args: buildAcpArgs(provider, config),
      permission: provider.permission ?? config.permission,
      ...(envKeys.length > 0 ? { env: provider.env } : {}),
    })
    const envNote = envKeys.length > 0 ? `，env: ${envKeys.join(',')}` : ''
    logger.info?.(`[dsh-acp-pool] provider ${provider.name}（${provider.model}，${provider.group} 组${envNote}）`)
  }

  const defineTool = await loadDefineTool()
  const readQuota = createQuotaReader(config.quota, logger)
  const readRoute = createRouteReader({ python: config.quota.python, workspace: config.quota.workspace })
  const providerNames = config.providers.map((provider) => provider.name)

  ctx.tools.register(defineTool({
    name: 'acp_delegate',
    description:
      '把一件自包含的任务委派给外部 ACP 模型（例如 Antigravity）。'
      + '按任务类型与额度自动挑模型（长文/设计倾向 Claude，批量/短任务倾向 Gemini）；也可用 provider 强制指定。'
      + 'prompt 必须自包含（子 agent 看不到本对话）；外部意见要交叉核对，冲突先摆冲突点。'
      + '返回子 agent id，完成后会通知。适合派完整任务，不适合高频小调用。',
    parameters: {
      description: { type: 'string', required: true, description: '3–5 个词的短标题，用于展示。' },
      prompt: { type: 'string', required: true, description: '完整、自包含的任务描述；子 agent 看不到本对话。' },
      cwd: { type: 'string', description: '可选：子 agent 的工作目录；省略则继承当前目录。' },
      provider: {
        type: 'string',
        enum: providerNames,
        description: '可选：强制指定 provider（跳过自动选择与 Jev 门禁）。',
      },
      profile: {
        type: 'string',
        enum: ['auto', 'fast', 'strong'],
        default: 'auto',
        description: 'auto = 按任务类型与额度；fast = 优先 gemini；strong = 优先 claude。',
      },
    },
    output: {
      schema: objectSchema({
        kind: { type: 'string', enum: ['activation', 'advice'], required: true },
        subagentId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        group: { type: 'string' },
        route: { type: 'string' },
        routeConfidence: { type: 'number' },
        reason: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      }),
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'advice'
          ? `未委派：${value.reason ?? '按建议自行处理'}`
          : `已委派 ${value.provider}（${value.model}）· 子 agent ${value.subagentId}`,
      }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 180_000,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('acp_delegate 需要一个调用方 agent')
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error('prompt 不能为空')
      if (prompt.length > 20_000) throw new Error('prompt 过长（上限 20000 字符）')
      const description = typeof args.description === 'string' && args.description.trim() !== ''
        ? args.description.trim()
        : prompt.slice(0, 40)
      const warnings = []
      let chosen
      let reason

      if (args.provider !== undefined) {
        chosen = config.providers.find((provider) => provider.name === args.provider)
        if (chosen === undefined) throw new Error(`未知 provider：${args.provider}`)
        reason = '调用方显式指定'
      } else {
        if (config.gate === 'jev') {
          const decision = await readRoute(`${description}\n${prompt}`.slice(0, 2000))
          if (decision === undefined) {
            warnings.push('Jev 路由查询失败，按任务类型继续')
          } else if (typeof decision.error === 'string' && decision.error !== '') {
            warnings.push(`Jev 路由降级为规则：${decision.error}`)
          } else if (gateDecision({ ...decision, threshold: config.gateConfidence }) === 'advice') {
            const confidence = typeof decision.confidence === 'number' ? decision.confidence.toFixed(2) : '?'
            return {
              kind: 'advice',
              route: 'dsh',
              ...(typeof decision.confidence === 'number' ? { routeConfidence: decision.confidence } : {}),
              reason: `Jev 判断该 DSH 自己执行（route=dsh, conf=${confidence}），未启动子 agent；确要委派就带 provider 再调`,
              warnings,
            }
          } else {
            const confidence = typeof decision.confidence === 'number'
              ? `（conf ${decision.confidence.toFixed(2)}）`
              : ''
            warnings.push(`Jev 路由 ${String(decision.route)} ${confidence}`)
          }
        }

        const preferred = preferGroup({ prompt, description, profile: args.profile ?? 'auto' })
        let availability
        if (config.quota.enabled) {
          availability = availabilityFromSummary(await readQuota())
          if (availability === undefined) warnings.push('额度未知（查询失败），按任务类型选组')
        }
        const picked = pickProvider({ providers: config.providers, preferred, availability })
        chosen = picked.provider
        reason = picked.reason
      }

      if (exec.signal?.aborted) throw abortError()
      const request = {
        ...(typeof args.cwd === 'string' && args.cwd !== '' ? { cwd: args.cwd } : {}),
        prompt: [{ type: 'text', text: prompt }],
        parent: exec.agent,
      }
      let activation
      try {
        activation = await ctx.subagents.startActivation({
          provider: chosen.name,
          label: description,
          request,
          signal: exec.signal,
          delivery: 'parent',
        })
      } catch (error) {
        throw new Error(`启动 ${chosen.name} 失败：${error instanceof Error ? error.message : String(error)}`)
      }

      logger.info?.(`[dsh-acp-pool] 委派 ${chosen.name}（${chosen.model}）→ ${activation.childId}`)
      return {
        kind: 'activation',
        subagentId: activation.childId,
        provider: chosen.name,
        model: chosen.model,
        group: chosen.group,
        reason,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    },
  }))

  logger.info?.(`[dsh-acp-pool] 已注册 ${config.providers.length} 个 provider；gate=${config.gate} quota=${config.quota.enabled ? 'on' : 'off'}`)
}
