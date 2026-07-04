import type { LlmAdapter } from './types'

const MODEL = 'anthropic/claude-sonnet-4.5'

/** OpenRouter chat completions; plain text in, plain text out. */
export function openRouterAdapter(apiKey: string, fetcher = fetch): LlmAdapter {
  return {
    async complete({ system, prompt, maxTokens }) {
      const res = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens ?? 1024,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`OpenRouter request failed: ${res.status}`)
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return data.choices?.[0]?.message?.content ?? ''
    },
  }
}
