/**
 * A stand-in for an OpenAI-compatible provider, for consistency-check.mjs.
 *
 * Imported first by that script so the environment below is in place before
 * config.ts reads it: the check process then has a server-configured provider
 * on loopback (a server provider is not refused as private; a user's is).
 * Answers are fixed rules on the prompt text, so the checks can assert exact
 * labels and lines without a network or a bill.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.CHECK_LLM_PORT ?? 5297);
process.env.FILTER_LLM_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.FILTER_LLM_MODELS_URL = `http://127.0.0.1:${PORT}/v1/models`;
process.env.FILTER_LLM_KEY = 'consistency-check';
process.env.FILTER_LLM_MODEL = 'fake-model';

/** Numbered message lines, as every prompt here writes them. */
const numbered = (text) => text.split('\n').filter((l) => /^\d+\. /.test(l));

function answer(system, user) {
  if (system.startsWith('You label')) {
    return {
      results: numbered(user).map((l, i) => ({
        n: i + 1,
        labels: /Invoice/.test(l) ? ['bill', 'action'] : /Your order/.test(l) ? ['receipt', 'spam'] : [],
      })),
    };
  }
  if (system.startsWith('You study')) return { filter: ['shop promotions and sales'], keep: ['receipts and invoices'] };
  if (system.startsWith('You write a short recap')) {
    const lines = numbered(user);
    const bill = lines.findIndex((l) => /Invoice/.test(l));
    return {
      summary: [`${lines.length} messages.`],
      needs: bill >= 0 ? [{ n: bill + 1, why: 'Pay the invoice' }] : [],
      notable: [{ n: 99, why: 'not offered' }],
    };
  }
  return { results: [] };
}

export function startFakeLlm() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      const { messages } = JSON.parse(body || '{}');
      seen.push(messages?.[1]?.content ?? '');
      const content = JSON.stringify(answer(messages?.[0]?.content ?? '', messages?.[1]?.content ?? ''));
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) =>
      reject(new Error(`fake model provider: port ${PORT} is busy (${err.code}); set CHECK_LLM_PORT to a free one`)),
    );
    server.listen(PORT, '127.0.0.1', () => resolve({ seen, close: () => new Promise((r) => server.close(r)) }));
  });
}
