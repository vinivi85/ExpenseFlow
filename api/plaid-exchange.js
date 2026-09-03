// Vercel Serverless Function
// Troca o public_token por um access_token permanente, cria o "item" (login no
// banco) e busca TODAS as contas dele. Não associa nenhuma a um cartão sozinho —
// devolve a lista pro app perguntar pro usuário qual conta é qual.

import { fetchBalancesForItem, applyBalanceToConnection } from './_plaid-lib.js';

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

  const plaidAccount = req.body?.plaid_account || 1;
  const { clientId, secret } = plaidCredsFor(plaidAccount);
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !secret || !supabaseUrl || !serviceKey) {
    res.status(500).json({ error: `Credenciais da conta Plaid ${plaidAccount} ou Supabase não configuradas no servidor` });
    return;
  }

  try {
    const { public_token, institution_name } = req.body;
    if (!public_token) { res.status(400).json({ error: 'public_token é obrigatório' }); return; }

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

    const accountsRes = await fetch(`${plaidBaseUrl()}/accounts/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret: secret, access_token: accessToken }),
    });
    const accountsData = await accountsRes.json();
    if (!accountsRes.ok) {
      res.status(accountsRes.status).json({ error: accountsData.error_message || 'Erro ao buscar contas' });
      return;
    }
    const accounts = accountsData.accounts || [];
    if (accounts.length === 0) {
      res.status(400).json({ error: 'Esse login não retornou nenhuma conta' });
      return;
    }

    const itemInsertRes = await supaFetch(supabaseUrl, serviceKey, 'plaid_items', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        plaid_item_id: itemId,
        plaid_access_token: accessToken,
        institution_name: institution_name || null,
        plaid_account: plaidAccount,
      }),
    });
    if (!itemInsertRes.ok) {
      const err = await itemInsertRes.text();
      res.status(500).json({ error: 'Erro ao salvar o login: ' + err });
      return;
    }
    const itemRow = (await itemInsertRes.json())[0];

    const connRows = accounts.map(a => ({
      item_ref: itemRow.id,
      institution_name: institution_name || null,
      account_name: a.name + (a.mask && !a.name.includes(a.mask) ? ' ...' + a.mask : ''),
      plaid_account_id: a.account_id,
      status: 'pending', // ainda não associado a um cartão
      card_id: null,
    }));

    const connInsertRes = await supaFetch(supabaseUrl, serviceKey, 'plaid_connections', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(connRows),
    });
    if (!connInsertRes.ok) {
      const err = await connInsertRes.text();
      res.status(500).json({ error: 'Erro ao salvar as contas: ' + err });
      return;
    }
    const savedConnections = await connInsertRes.json();

    // Busca o saldo de todas as contas já de cara (uma chamada só), pra ficar pronto
    // quando o usuário associar
    const balResult = await fetchBalancesForItem({ clientId, secret, accessToken });
    if (!balResult.error) {
      for (const conn of savedConnections) {
        await applyBalanceToConnection({ supabaseUrl, serviceKey, conn, accounts: balResult.accounts });
      }
    }

    res.status(200).json({
      ok: true,
      institution_name: institution_name || null,
      connections: savedConnections.map(c => ({ id: c.id, account_name: c.account_name })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
