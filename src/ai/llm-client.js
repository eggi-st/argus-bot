'use strict'
const fetch = require('node-fetch')

/**
 * Call an OpenAI-compatible chat completion endpoint.
 * Compatible with SumoPod, Ollama, LM Studio, and any OpenAI-API proxy.
 */
async function callLLM(prompt, cfg = {}) {
  const url    = cfg.sumopodUrl || 'http://localhost:11434/v1/chat/completions'
  const model  = cfg.model      || 'llama3'
  const maxTok = cfg.maxTokens  || 100
  const timeMs = cfg.timeoutMs  || 20_000

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens:  maxTok,
      stream:      false,
    }),
    timeout: timeMs,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 120)}`)
  }

  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty LLM response')
  return text.trim()
}

module.exports = { callLLM }
