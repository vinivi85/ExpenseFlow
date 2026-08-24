// Lógica compartilhada de sincronização com o Plaid, usada pelo botão manual
// "Sincronizar tudo", pelo cron diário e pela sincronização individual por cartão.
// Não é uma rota (o "_" no nome do arquivo faz a Vercel ignorar isso como endpoint).
//
// Modelo de dados: um "Item" do Plaid (um login no banco) fica em plaid_items,
// com o access_token guardado UMA vez. Cada CONTA dentro desse login (checking,
// business checking, linha de crédito...) vira uma linha em plaid_connections,
// associada (ou não ainda) a um cartão cadastrado.

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

const PLAID_CATEGORY_MAP = {
  FOOD_AND_DRINK: 'Restaurante',
  GROCERIES: 'Mercado',
  GENERAL_MERCHANDISE: 'Compras',
  TRANSPORTATION: 'Transporte',
  TRAVEL: 'Viagem',
  RENT_AND_UTILITIES: 'Contas Fixas',
  MEDICAL: 'Saúde',
  PERSONAL_CARE: 'Saúde',
  ENTERTAINMENT: 'Lazer',
  EDUCATION: 'Educação',
  HOME_IMPROVEMENT: 'Casa',
  LOAN_PAYMENTS: 'Contas Fixas',
  GENERAL_SERVICES: 'Contas Fixas',
};

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

// Busca saldo/limite de UMA conta específica dentro de um item e atualiza no banco.
// Busca o saldo de TODAS as contas de um item numa chamada só — antes isso rodava
// uma vez por conta (3-4x pro mesmo login em bancos como a Capital One), o que
// pode disparar limite de taxa da API e fazer contas depois da primeira falharem.
async function fetchBalancesForItem({ clientId, secret, accessToken }) {
  try {
    const balRes = await fetch(`${plaidBaseUrl()}/accounts/balance/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret: secret, access_token: accessToken }),
    });
    const balData = await balRes.json();
    if (!balRes.ok) return { error: balData.error_message || balData.error_code || 'Erro ao buscar saldo' };
    return { accounts: balData.accounts || [] };
  } catch (e) {
    return { error: e.message };
  }
}

async function applyBalanceToConnection({ supabaseUrl, serviceKey, conn, accounts }) {
  const account = (accounts || []).find(a => a.account_id === conn.plaid_account_id);
  if (!account) return { error: 'Conta não encontrada no retorno do Plaid' };
  const balances = account.balances || {};
  await supaFetch(supabaseUrl, serviceKey, `plaid_connections?id=eq.${conn.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      current_balance: balances.current,
      available_balance: balances.available,
      credit_limit: balances.limit,
      iso_currency_code: balances.iso_currency_code,
      balance_updated_at: new Date().toISOString(),
    }),
  });
  return { ok: true };
}

// Mantido pra compatibilidade — busca e aplica pra uma única conexão de uma vez.
async function fetchAndStoreBalance({ supabaseUrl, serviceKey, clientId, secret, accessToken, conn }) {
  const balResult = await fetchBalancesForItem({ clientId, secret, accessToken });
  if (balResult.error) return { error: balResult.error };
  return applyBalanceToConnection({ supabaseUrl, serviceKey, conn, accounts: balResult.accounts });
}

// Sincroniza UM item (um login no banco) — puxa as transações de TODAS as contas
// daquele login de uma vez (é assim que a API do Plaid funciona), e distribui cada
// transação pro cartão certo com base em qual conta ela pertence.
async function syncOneItem({ supabaseUrl, serviceKey, clientId, secret, item, connections, cardById, categoryNames, defaultUser }) {
  let cursor = item.cursor || null;
  let added = [];
  let hasMore = true;
  while (hasMore) {
    const syncRes = await fetch(`${plaidBaseUrl()}/transactions/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId, secret: secret,
        access_token: item.plaid_access_token,
        cursor: cursor || undefined,
      }),
    });
    const syncData = await syncRes.json();
    if (!syncRes.ok) {
      return { error: syncData.error_message || 'Erro ao sincronizar' };
    }
    added = added.concat(syncData.added || []);
    cursor = syncData.next_cursor;
    hasMore = syncData.has_more;
  }

  // Mapa account_id -> nome do cartão (só pras contas que já foram associadas a um cartão)
  const cardNameByAccount = {};
  connections.forEach(c => {
    if (c.card_id && cardById[c.card_id]) cardNameByAccount[c.plaid_account_id] = cardById[c.card_id];
  });

  const candidates = added
    .filter(t => !t.pending && t.amount > 0 && cardNameByAccount[t.account_id]) // ignora contas ainda não associadas a um cartão
    .map(t => {
      const primaryCat = t.personal_finance_category?.primary;
      const category = PLAID_CATEGORY_MAP[primaryCat] || categoryNames[categoryNames.length - 1] || 'Outros';
      return {
        description: t.merchant_name || t.name || 'Transação',
        amount: Math.abs(t.amount),
        category,
        card: cardNameByAccount[t.account_id],
        date: t.date,
        added_by: defaultUser,
        source: 'plaid',
      };
    });

  // Busca despesas já existentes só pra checar duplicata EXATA (essa continua pulando
  // sozinha, sem nem entrar na revisão). Todo o resto — mesmo sem parecer duplicata
  // nenhuma — vai pra fila de revisão em Lançamentos, não entra direto em expenses.
  const toPending = [];
  if (candidates.length > 0) {
    const existingRes = await supaFetch(supabaseUrl, serviceKey, 'expenses?select=description,amount,card,date');
    const existing = existingRes.ok ? await existingRes.json() : [];
    const sig = (d, desc, amt) => `${d}|${(desc || '').trim().toLowerCase().replace(/\s+/g, ' ')}|${Number(amt).toFixed(2)}`;
    const exactSigs = new Set(existing.map(e => sig(e.date, e.description, e.amount)));

    for (const c of candidates) {
      if (exactSigs.has(sig(c.date, c.description, c.amount))) continue; // duplicata exata — pula, nem manda pra revisão
      const possibleMatch = existing.find(e =>
        e.date === c.date &&
        Math.abs(Number(e.amount) - Number(c.amount)) < 0.01 &&
        (e.card || '').trim().toLowerCase() === (c.card || '').trim().toLowerCase() &&
        (e.description || '').trim().toLowerCase() !== c.description.trim().toLowerCase()
      );
      toPending.push({ ...c, matched_description: possibleMatch ? possibleMatch.description : null });
    }
  }

  if (toPending.length > 0) {
    const pendingRes = await supaFetch(supabaseUrl, serviceKey, 'plaid_pending_transactions', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(toPending),
    });
    if (!pendingRes.ok) {
      const errText = await pendingRes.text();
      return { error: 'Erro ao salvar pendentes: ' + errText };
    }
  }

  await supaFetch(supabaseUrl, serviceKey, `plaid_items?id=eq.${item.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ cursor, last_synced_at: new Date().toISOString() }),
  });

  // Busca o saldo de todas as contas desse item UMA VEZ SÓ (antes chamava a API
  // repetida pra cada conta do mesmo login, o que podia esbarrar em limite de taxa
  // e fazer as contas seguintes falharem silenciosamente).
  const balanceErrors = [];
  const balResult = await fetchBalancesForItem({ clientId, secret, accessToken: item.plaid_access_token });
  if (balResult.error) {
    balanceErrors.push(`(login inteiro) ${balResult.error}`);
  } else {
    for (const conn of connections) {
      const result = await applyBalanceToConnection({ supabaseUrl, serviceKey, conn, accounts: balResult.accounts });
      if (result.error) balanceErrors.push(`${conn.account_name || conn.id}: ${result.error}`);
    }
  }
  await supaFetch(supabaseUrl, serviceKey, `plaid_connections?item_ref=eq.${item.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'connected', last_synced_at: new Date().toISOString() }),
  });

  return { imported: 0, pending: toPending.length, balanceErrors: balanceErrors.length ? balanceErrors : undefined };
}

// Sincroniza TODOS os items (logins) ativos de uma vez (usado pelo botão "Sincronizar tudo" e pelo cron).
async function syncAllConnections({ supabaseUrl, serviceKey, clientId, secret }) {
  const [itemRes, connRes, cardRes, catRes, userRes] = await Promise.all([
    supaFetch(supabaseUrl, serviceKey, 'plaid_items?select=*'),
    supaFetch(supabaseUrl, serviceKey, 'plaid_connections?select=*'),
    supaFetch(supabaseUrl, serviceKey, 'cards?select=id,name'),
    supaFetch(supabaseUrl, serviceKey, 'categories?select=name'),
    supaFetch(supabaseUrl, serviceKey, 'users?select=name&order=created_at.asc&limit=1'),
  ]);
  const items = await itemRes.json();
  const allConnections = await connRes.json();
  const cardRows = await cardRes.json();
  const categoryNames = (await catRes.json()).map(c => c.name);
  const defaultUser = (await userRes.json())[0]?.name || 'Vinicius';
  const cardById = {};
  cardRows.forEach(c => { cardById[c.id] = c.name; });

  const results = [];
  for (const item of items) {
    const connections = allConnections.filter(c => c.item_ref === item.id);
    const result = await syncOneItem({ supabaseUrl, serviceKey, clientId, secret, item, connections, cardById, categoryNames, defaultUser });
    results.push({ institution: item.institution_name || 'Banco', ...result });
  }
  return results;
}

export { syncOneItem, syncAllConnections, plaidBaseUrl, fetchAndStoreBalance, fetchBalancesForItem, applyBalanceToConnection };
