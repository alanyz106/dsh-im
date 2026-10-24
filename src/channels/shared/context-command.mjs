import { t } from './i18n.mjs';
import { splitWorkspaceCommandMessage } from './workspace-command.mjs';

const CONTEXT_COMMAND = /^\/context(?=$|\s)([\s\S]*)$/iu;
const CONTEXT_USAGE = '用法：/context（查看当前会话的上下文用量）';
const READ_TIMEOUT_MS = 10_000;

function commandResult(message) {
  return { handled: true, message, messages: splitWorkspaceCommandMessage(message) };
}

/** Render an integer with thousands separators without depending on ICU. */
function grouped(value) {
  const digits = String(Math.max(0, Math.round(value)));
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ',';
    out += digits[index];
  }
  return out;
}

/** Wrap a provider figure in an approximate marker; heuristics are not exact. */
function formatTokens(value, { approximate = false } = {}) {
  const base = grouped(value);
  return approximate ? `≈ ${base}` : base;
}

/**
 * Build the human-facing report from a snapshot produced by
 * `HarnessClient#getSessionContext`. Prefers the provider-reported pressure and
 * falls back to the heuristic surface composition when the provider is silent.
 */
export function formatContextReport(snapshot) {
  const { sessionId, pressure, breakdown, usage } = snapshot;
  const shortId = sessionId.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 12);
  const lines = [t('上下文用量｜{session}', { session: shortId })];

  const window = pressure?.contextWindow;
  const used = pressure?.pressureTokens ?? pressure?.projectedTokens;

  if (typeof used === 'number' && used > 0) {
    if (typeof window === 'number' && window > 0) {
      const ratio = Math.min(100, (used / window) * 100);
      lines.push(t('已用：{used} / {total} tokens（{percent}%）', {
        used: formatTokens(used),
        total: formatTokens(window),
        percent: ratio < 10 ? ratio.toFixed(1) : Math.round(ratio).toString(),
      }));
    } else {
      lines.push(t('已用：{used} tokens', { used: formatTokens(used) }));
    }
    if (typeof pressure.projectedTokens === 'number' && pressure.projectedTokens > 0
      && pressure.projectedTokens !== used) {
      lines.push(t('下次请求预计：{tokens} tokens', {
        tokens: formatTokens(pressure.projectedTokens, { approximate: true }),
      }));
    }
  } else if (breakdown) {
    const estimated = breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens;
    if (estimated > 0) {
      // No provider sample yet: the composition is a heuristic, so say so.
      lines.push(t('已用：约 {used} tokens（模型尚未上报用量，此为估算）', {
        used: formatTokens(estimated, { approximate: true }),
      }));
      if (typeof window === 'number' && window > 0) {
        const ratio = Math.min(100, (estimated / window) * 100);
        lines.push(t('占窗口：{total} tokens（{percent}%）', {
          total: formatTokens(window),
          percent: ratio < 10 ? ratio.toFixed(1) : Math.round(ratio).toString(),
        }));
      }
    } else {
      lines.push(t('当前会话还没有可统计的上下文。'));
    }
  } else {
    lines.push(t('当前会话还没有可统计的上下文。'));
  }

  if (breakdown) {
    const estimated = breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens;
    if (estimated > 0) {
      lines.push('');
      lines.push(t('构成（估算）：'));
      lines.push(t('  系统提示  {tokens}', { tokens: formatTokens(breakdown.systemTokens) }));
      lines.push(t('  工具定义  {tokens}', { tokens: formatTokens(breakdown.toolsTokens) }));
      lines.push(t('  消息历史  {tokens}', { tokens: formatTokens(breakdown.messageTokens) }));
    }
  }

  const billed = usage
    ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    : 0;
  if (usage && (billed > 0 || usage.outputTokens > 0)) {
    lines.push('');
    lines.push(t('累计用量：'));
    lines.push(t('  输入  {tokens}', { tokens: formatTokens(billed) }));
    if (usage.cacheReadTokens > 0 && billed > 0) {
      const hitRate = Math.round((usage.cacheReadTokens / billed) * 100);
      lines.push(t('  其中缓存命中  {tokens}（{percent}%）', {
        tokens: formatTokens(usage.cacheReadTokens),
        percent: String(hitRate),
      }));
    }
    lines.push(t('  输出  {tokens}', { tokens: formatTokens(usage.outputTokens) }));
  }

  if (snapshot.projectionKind === 'cached' && !snapshot.live) {
    lines.push('');
    lines.push(t('说明：该会话当前没有活跃 Agent，以上数值取自持久化快照。'));
  }

  return commandResult(lines.join('\n'));
}

export function isContextCommand(text) {
  return typeof text === 'string' && CONTEXT_COMMAND.test(text.trim());
}

/** Read the current binding only; never create/resume a session or prompt the model. */
export async function runContextCommand(text, harness, state, key, {
  signal: callerSignal,
  hasImages = false,
  hasFiles = false,
} = {}) {
  if (!isContextCommand(text)) return null;
  const argument = CONTEXT_COMMAND.exec(text.trim())[1].trim();
  if (argument) return commandResult(t(CONTEXT_USAGE));
  if (hasImages || hasFiles) return commandResult(t('/context 仅支持文字命令，请移除图片或文件后重试。'));
  const sessionId = state?.sessionFor?.(key);
  if (typeof sessionId !== 'string' || !sessionId) {
    return commandResult(t('当前聊天尚未绑定会话，请先发送消息或使用 /session 绑定会话。'));
  }

  try {
    const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const snapshot = await harness.getSessionContext(sessionId, { signal });
    if (!snapshot) {
      return commandResult(t('当前聊天绑定的会话已不存在，请重新绑定会话。'));
    }
    if (state.sessionFor(key) !== sessionId) {
      return commandResult(t('会话、工作区或机器人状态已发生变化，请重新执行 /context。'));
    }
    return formatContextReport(snapshot);
  } catch (error) {
    if (error?.name === 'AbortError') return commandResult(t('上下文用量读取已取消。'));
    return commandResult(t('暂时无法读取上下文用量，请稍后重试。'));
  }
}
