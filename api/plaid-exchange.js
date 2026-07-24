// Vercel Serverless Function
// Troca o public_token (temporário, devolvido pelo Plaid Link no navegador)
// por um access_token permanente, e guarda a conexão associada a um cartão
// já cadastrado. Usa a service_role key do Supabase (bypassa RLS), então essa
// tabela nunca fica acessível pela chave pública do app.

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
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !secret) {
    res.status(500).json({ error: 'PLAID_CLIENT_ID/PLAID_SECRET não configurados no servidor' });
    return;
  }
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados no servidor' });
    return;
  }

  try {
    const { public_token, card_id, institution_name } = req.body;
    if (!public_token || !card_id) {
      res.status(400).json({ error: 'public_token e card_id são obrigatórios' });
      return;
    }

    const exchangeRes = await fetch(`${plaidBaseUrl()}/item/public_token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret: secret, public_token }),
    });
    const exchangeData = await exchangeRes.json();
    if (!exchangeRes.ok) {
      res.status(exchangeRes.status).json({ error: exchangeData.error_message || 'Erro ao trocar o token', detail: exchangeData });
      return;
    }

    const accessToken = exchangeData.access_token;
    const itemId = exchangeData.item_id;

    // Busca as contas dessa conexão pra guardar o nome real (ajuda a conferir depois)
    let accountName = null, accountId = null;
    try {
      const accountsRes = await fetch(`${plaidBaseUrl()}/accounts/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, secret: secret, access_token: accessToken }),
      });
      const accountsData = await accountsRes.json();
      if (accountsRes.ok && accountsData.accounts && accountsData.accounts[0]) {
        accountName = accountsData.accounts[0].name;
        accountId = accountsData.accounts[0].account_id;
      }
    } catch (e) { /* segue sem o nome, não é crítico */ }

    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/plaid_connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        card_id,
        institution_name: institution_name || null,
        account_name: accountName,
        plaid_item_id: itemId,
        plaid_access_token: accessToken,
        plaid_account_id: accountId,
        status: 'connected',
      }),
    });
    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      res.status(500).json({ error: 'Erro ao salvar a conexão: ' + err });
      return;
    }

    res.status(200).json({ ok: true, account_name: accountName });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
