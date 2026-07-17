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
    const { messages } = req.body;
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

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
        }),
      }
    );

    const data = await upstream.json();

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data.error?.message || 'Erro na API do Gemini', detail: data });
      return;
    }

    // Traduz a resposta do Gemini de volta pro formato que o front-end espera
    // (o mesmo shape { content: [{type:"text", text:"..."}] } usado antes com a Anthropic).
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
