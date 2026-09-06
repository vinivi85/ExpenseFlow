// Vercel Serverless Function
// Faz proxy para a API do Google Gemini (tier gratuito), mantendo a chave
// secreta no servidor. Configure a variável de ambiente GEMINI_API_KEY no
// painel da Vercel (Project Settings → Environment Variables).
// Pegue a chave grátis em https://aistudio.google.com/apikey (não pede cartão).

const GEMINI_MODEL = 'gemini-3.5-flash';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor' });
    return;
  }

  try {
    // O front-end manda um formato parecido com o da Anthropic (messages: [{role, content}]).
    // Aqui a gente traduz pro formato do Gemini (contents: [{parts: [...]}]).
    const { messages, json } = req.body;
    const msg = messages[0];

    const parts = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'document' && block.source?.type === 'base64') {
          parts.push({
            inline_data: {
              mime_type: block.source.media_type || 'application/pdf',
              data: block.source.data,
            },
          });
        }
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: json
              ? { maxOutputTokens: 32768, responseMimeType: 'application/json' }
              : { maxOutputTokens: 8192 },
          }),
          signal: controller.signal,
        }
      );
    } catch (fetchErr) {
      clearTimeout(timeout);
      if (fetchErr.name === 'AbortError') {
        res.status(504).json({ error: 'O Gemini demorou demais pra responder (mais de 90s). Tenta um PDF menor ou de novo.' });
        return;
      }
      throw fetchErr;
    }
    clearTimeout(timeout);

    const data = await upstream.json();

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data.error?.message || 'Erro na API do Gemini', detail: data });
      return;
    }

    // Traduz a resposta do Gemini de volta pro formato que o front-end espera
    // (o mesmo shape { content: [{type:"text", text:"..."}] } usado antes com a Anthropic).
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      res.status(422).json({ error: 'A fatura tem transações demais pra processar de uma vez. Tenta dividir o PDF em partes menores.', truncated: true });
      return;
    }
    // Sem candidato nenhum — geralmente é conteúdo bloqueado pelo filtro de segurança
    // do Gemini, ou algum outro motivo que faria o app tratar como "sucesso vazio"
    // e mostrar só "Nenhuma transação encontrada" sem dizer o motivo de verdade.
    if (!candidate) {
      const blockReason = data.promptFeedback?.blockReason;
      res.status(422).json({
        error: blockReason
          ? `O Gemini bloqueou essa imagem/arquivo (motivo: ${blockReason}). Tenta outra foto/print.`
          : 'O Gemini não retornou nenhuma resposta pra esse arquivo. Tenta de novo ou usa outra foto/print.',
        detail: data,
      });
      return;
    }
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      res.status(422).json({ error: `O Gemini parou de processar antes de terminar (motivo: ${candidate.finishReason}). Tenta de novo.`, detail: data });
      return;
    }
    const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text.trim()) {
      res.status(422).json({ error: 'O Gemini respondeu vazio pra esse arquivo. Tenta de novo ou usa outra foto/print.', detail: data });
      return;
    }
    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
