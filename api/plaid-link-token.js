// Vercel Serverless Function
// Cria um "link_token" do Plaid — o token temporário que inicializa o widget
// de conexão (Plaid Link) no navegador. Usa PLAID_CLIENT_ID/PLAID_SECRET (conta 1)
// ou PLAID_CLIENT_ID_2/PLAID_SECRET_2 (conta 2), conforme o tipo de conta que está
// sendo conectado escolheu em Config — duas contas Plaid separadas, cada uma com
// seu próprio limite de 10 conexões, juntas dão 20.
//
// PLAID_ENV deve ser "sandbox" ou "production" (variável de ambiente).

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

function plaidCredsFor(account) {
  if (Number(account) === 2) {
    return { clientId: process.env.PLAID_CLIENT_ID_2, secret: process.env.PLAID_SECRET_2 };
  }
  return { clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const plaidAccount = req.body?.plaid_account || 1;
  const { clientId, secret } = plaidCredsFor(plaidAccount);
  if (!clientId || !secret) {
    res.status(500).json({ error: `Credenciais da conta Plaid ${plaidAccount} não configuradas no servidor` });
    return;
  }

  try {
    const body = {
      client_id: clientId,
      secret: secret,
      client_name: 'Expense Flow',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: 'expenseflow-household' },
      products: ['transactions'],
    };
    // Necessário pra bancos que usam login OAuth (a maioria hoje) — sem isso,
    // depois do login no site do banco não tem como o widget voltar pro nosso app.
    // A mesma URL precisa estar cadastrada no painel do Plaid (Team Settings → API →
    // Allowed redirect URIs).
    if (process.env.PLAID_REDIRECT_URI) {
      body.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }
    const upstream = await fetch(`${plaidBaseUrl()}/link/token/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
