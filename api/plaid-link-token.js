// Vercel Serverless Function
// Cria um "link_token" do Plaid — o token temporário que inicializa o widget
// de conexão (Plaid Link) no navegador. Usa PLAID_CLIENT_ID e PLAID_SECRET
// guardados como variáveis de ambiente na Vercel (nunca expostos no frontend).
//
// PLAID_ENV deve ser "sandbox" ou "production" (variável de ambiente).

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    res.status(500).json({ error: 'PLAID_CLIENT_ID/PLAID_SECRET não configurados no servidor' });
    return;
  }

  try {
    const upstream = await fetch(`${plaidBaseUrl()}/link/token/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        secret: secret,
        client_name: 'Expense Flow',
        language: 'en',
        country_codes: ['US'],
        user: { client_user_id: 'expenseflow-household' },
        products: ['transactions'],
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data.error_message || 'Erro ao criar link_token', detail: data });
      return;
    }
    res.status(200).json({ link_token: data.link_token });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
