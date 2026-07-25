// Vercel Serverless Function
// Desconecta um cartão do Plaid: tenta remover o item no lado do Plaid (boa prática,
// libera a vaga contra o limite de Items) e sempre remove a conexão local, mesmo se
// a remoção no Plaid falhar (ex: token de Sandbox que não vale mais em produção).

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
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados no servidor' });
    return;
  }

  try {
    const { card_id } = req.body;
    if (!card_id) { res.status(400).json({ error: 'card_id é obrigatório' }); return; }

    const connRes = await fetch(`${supabaseUrl}/rest/v1/plaid_connections?card_id=eq.${card_id}&select=*`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
    });
    const connections = await connRes.json();
    if (!connections || connections.length === 0) {
      res.status(404).json({ error: 'Cartão não tem conexão pra desconectar' });
      return;
    }

    // Tenta remover no lado do Plaid — se o token for inválido (ex: sobra de teste
    // do Sandbox depois de trocar pra produção), ignora o erro e segue removendo local.
    if (clientId && secret) {
      try {
        await fetch(`${plaidBaseUrl()}/item/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, secret: secret, access_token: connections[0].plaid_access_token }),
        });
      } catch (e) { /* não bloqueia a remoção local */ }
    }

    const delRes = await fetch(`${supabaseUrl}/rest/v1/plaid_connections?card_id=eq.${card_id}`, {
      method: 'DELETE',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
    });
    if (!delRes.ok) {
      const err = await delRes.text();
      res.status(500).json({ error: 'Erro ao remover conexão: ' + err });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
