// Vercel Serverless Function
// Associa uma conta do Plaid (que veio "pendente" depois de conectar) a um cartão
// cadastrado — cria o cartão na hora se precisar — e acrescenta o nome real da
// conta, entre parênteses, no nome do cartão.

async function supaFetch(supabaseUrl, serviceKey, path, opts = {}) {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      ...(opts.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados no servidor' });
    return;
  }

  try {
    const { connection_id, card_id, new_card_name } = req.body;
    if (!connection_id) { res.status(400).json({ error: 'connection_id é obrigatório' }); return; }
    if (!card_id && !new_card_name) { res.status(400).json({ error: 'Informe card_id ou new_card_name' }); return; }

    const connRes = await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${connection_id}&select=*`);
    const connRows = await connRes.json();
    if (!connRows || connRows.length === 0) { res.status(404).json({ error: 'Conexão não encontrada' }); return; }
    const conn = connRows[0];

    let finalCardId = card_id;
    if (!finalCardId && new_card_name) {
      const cardInsertRes = await supaFetch(supabaseUrl, serviceKey, 'cards', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ name: new_card_name.trim() }),
      });
      if (!cardInsertRes.ok) {
        const err = await cardInsertRes.text();
        res.status(500).json({ error: 'Erro ao criar cartão: ' + err });
        return;
      }
      finalCardId = (await cardInsertRes.json())[0].id;
    }

    // Regra: sempre que conectar via Plaid, o nome do cartão passa a ser
    // exatamente o que o Plaid devolveu (a descrição real da conta), pra nunca
    // ficar desalinhado entre o que tá cadastrado e o que a conta realmente é.
    if (conn.account_name) {
      await supaFetch(supabaseUrl, serviceKey, `cards?id=eq.${finalCardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: conn.account_name }),
      });
    }

    const updateRes = await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${connection_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ card_id: finalCardId, status: 'connected' }),
    });
    if (!updateRes.ok) {
      const err = await updateRes.text();
      res.status(500).json({ error: 'Erro ao associar: ' + err });
      return;
    }

    res.status(200).json({ ok: true, card_id: finalCardId });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
