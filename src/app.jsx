import React, {useState,useEffect,useRef,useMemo} from 'react';
import ReactDOM from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import * as pdfjsLib from 'pdfjs-dist';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';

async function extractPdfText(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = '';
  for(let i=1; i<=pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(it=>it.str).join(' ') + '\n';
  }
  return fullText;
}

// Parser CSV simples que lida com campos entre aspas (vírgulas dentro de descrição, etc.)
function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i], next = text[i+1];
    if(inQuotes){
      if(c==='"' && next==='"'){ field+='"'; i++; }
      else if(c==='"'){ inQuotes=false; }
      else field += c;
    } else {
      if(c==='"') inQuotes = true;
      else if(c===','){ row.push(field); field=''; }
      else if(c==='\r'){ /* skip */ }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  if(rows.length===0) return [];
  const headers = rows[0].map(h=>h.trim());
  return rows.slice(1).filter(r=>r.length>1).map(r=>{
    const obj = {};
    headers.forEach((h,i)=>{ obj[h] = (r[i]||'').trim(); });
    return obj;
  });
}

// Mapeia categorias comuns do statement da Apple Card (ou outros bancos) pras nossas categorias
const CARD_CATEGORY_MAP = {
  'restaurants':'Restaurante','food':'Restaurante','dining':'Restaurante',
  'grocery':'Mercado','groceries':'Mercado','supermarket':'Mercado',
  'transportation':'Transporte','gas':'Transporte','automotive':'Transporte',
  'health/personal care':'Saúde','health':'Saúde','pharmacy':'Saúde',
  'entertainment':'Lazer',
  'shopping':'Compras','retail':'Compras',
  'education':'Educação',
  'travel':'Viagem',
  'bills':'Contas Fixas','utilities':'Contas Fixas','payment':'Contas Fixas',
};
function mapCardCategory(raw, categories){
  if(!raw) return null;
  const rl = raw.trim().toLowerCase();
  const exact = categories.find(c=>c.toLowerCase()===rl);
  if(exact) return exact;
  const mapped = CARD_CATEGORY_MAP[rl];
  if(mapped && categories.includes(mapped)) return mapped;
  return null;
}

const MONTH_NAMES = {jan:0,fev:1,feb:1,mar:2,abr:3,apr:3,mai:4,may:4,jun:5,jul:6,ago:7,aug:7,set:8,sep:8,out:9,oct:9,nov:10,dez:11,dec:11};

function parseMonthDayFormat(s, currentYear){
  let m = s.match(/^([A-Za-zçÇ]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  let monthStr, day, year;
  if(m){ monthStr = m[1]; day = m[2]; year = m[3]; }
  else {
    m = s.match(/^(\d{1,2})\s+(?:de\s+)?([A-Za-zçÇ]{3,9})\.?(?:,?\s+(?:de\s+)?(\d{4}))?$/);
    if(m){ day = m[1]; monthStr = m[2]; year = m[3]; }
  }
  if(!m) return null;
  const key = monthStr.toLowerCase().slice(0,3);
  const monthIdx = MONTH_NAMES[key];
  if(monthIdx===undefined) return null;
  const y = year ? parseInt(year,10) : currentYear;
  const d = new Date(Date.UTC(y, monthIdx, parseInt(day,10)));
  if(isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}

const WEEKDAYS_EN = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const WEEKDAYS_PT = ['domingo','segunda','terça','terca','quarta','quinta','sexta','sábado','sabado'];

// Resolve rótulos relativos (Today, Yesterday, nome de dia da semana em PT/EN, "N hours/minutes ago")
// pra data real, sempre olhando pra trás a partir de hoje (nunca uma data futura).
function resolveRelativeDate(raw){
  if(!raw) return null;
  const s = raw.trim().toLowerCase();
  const today = new Date();
  if(s==='today' || s==='hoje' || s==='now' || s==='agora') return today.toISOString().slice(0,10);
  if(s==='pending' || s==='pendente') return today.toISOString().slice(0,10);
  if(/^\d+\s*(hour|hr|minute|min|second|sec)s?\s*ago$/.test(s)) return today.toISOString().slice(0,10);
  if(s==='yesterday' || s==='ontem'){
    const d = new Date(today.getTime()-86400000);
    return d.toISOString().slice(0,10);
  }
  let targetDow = WEEKDAYS_EN.indexOf(s);
  if(targetDow===-1){
    if(s.startsWith('ter')) targetDow = 2;
    else if(s.startsWith('sáb')||s.startsWith('sab')) targetDow = 6;
    else targetDow = WEEKDAYS_PT.findIndex(w=>s.startsWith(w));
  }
  if(targetDow>=0){
    const todayDow = today.getDay();
    let diff = todayDow - targetDow;
    if(diff<0) diff += 7; // sempre pra trás, nunca data futura
    const d = new Date(today.getTime()-diff*86400000);
    return d.toISOString().slice(0,10);
  }
  return null;
}

function normalizeDate(raw){
  if(!raw) return new Date().toISOString().slice(0,10);
  const s = raw.trim();
  const relative = resolveRelativeDate(s);
  if(relative) return relative;
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m){ return m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0'); }
  const monthDay = parseMonthDayFormat(s, new Date().getFullYear());
  if(monthDay) return monthDay;
  const d = new Date(s);
  if(!isNaN(d.getTime())) return d.toISOString().slice(0,10);
  return new Date().toISOString().slice(0,10);
}

// Tenta achar um usuário cadastrado dentro do texto de "Purchased By" (ex: "Aline Vicente" bate com o usuário "Aline")
function matchUserFromText(raw, users){
  if(!raw) return null;
  const rl = raw.trim().toLowerCase();
  return (users||[]).find(u=>rl.includes(u.trim().toLowerCase())) || null;
}

function parseCardCSV(text, categories, users){
  const rows = parseCSV(text);
  const items = [];
  for(const r of rows){
    // Apple Card: "Transaction Date","Clearing Date","Description","Merchant","Category","Type","Amount (USD)","Purchased By"
    const type = (r['Type']||'').toLowerCase();
    if(type==='payment') continue; // ignora pagamentos da fatura
    const amountRaw = r['Amount (USD)'] ?? r['Amount'] ?? r['amount'];
    if(amountRaw===undefined) continue;
    const amount = Math.abs(parseFloat(String(amountRaw).replace(/[^0-9.-]/g,'')));
    if(!amount || isNaN(amount)) continue;
    const desc = r['Description'] || r['Merchant'] || r['description'] || 'Transação';
    const date = normalizeDate(r['Transaction Date'] || r['Date'] || r['date']);
    const category = mapCardCategory(r['Category'] || r['category'], categories) || categories[categories.length-1] || 'Outros';
    const matchedUser = matchUserFromText(r['Purchased By'], users);
    items.push({ date, description: desc, amount, category, include:true, added_by: matchedUser || undefined });
  }
  return items;
}

const DEFAULT_CATEGORIES = ["Mercado","Restaurante","Transporte","Casa","Contas Fixas","Saúde","Lazer","Compras","Educação","Pets","Viagem","Outros"];
const DEFAULT_USERS = ["Vinicius"];
const ALL_VIEW = '__todos__'; // sentinel pra "ver a casa inteira" no seletor de usuário

// Supabase fixo do projeto — não precisa configurar por aparelho.
// A chave "publishable" é feita pra ficar exposta no frontend (protegida por RLS no banco).
const BUILTIN_SUPABASE_URL = "https://lzjbsbdwxqmguywiokqw.supabase.co";
const BUILTIN_SUPABASE_KEY = "sb_publishable_mbxt1YWB7UJhwpq6hZXqgg_WHrZJJV_";

function loadCfg(){
  try{
    const saved = JSON.parse(localStorage.getItem('gastos_cfg')||'{}');
    return { url: saved.url || BUILTIN_SUPABASE_URL, key: saved.key || BUILTIN_SUPABASE_KEY };
  }catch(e){ return { url: BUILTIN_SUPABASE_URL, key: BUILTIN_SUPABASE_KEY }; }
}
function saveCfg(c){ localStorage.setItem('gastos_cfg', JSON.stringify(c)); }

function getClient(cfg){
  if(!cfg.url || !cfg.key) return null;
  return createClient(cfg.url, cfg.key);
}

async function callClaude(payload){
  // Chama nossa função serverless (/api/gemini), que guarda a chave do Google
  // em segredo no servidor e repassa a chamada pra API real (tier gratuito).
  const res = await fetch("/api/gemini", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const raw = await res.text();
  let data;
  try{ data = JSON.parse(raw); }
  catch(e){
    if(res.status===413 || /request entity too large/i.test(raw)) throw new Error('PDF muito grande (limite ~4MB). Tenta um arquivo menor ou só as páginas com transações.');
    throw new Error('Resposta inválida do servidor (status '+res.status+'). Tenta de novo em alguns segundos.');
  }
  if(!res.ok){ throw new Error(data.error || 'Erro ao chamar a IA'); }
  const textBlocks = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");
  return textBlocks;
}

function extractJson(text){
  let t = text.trim().replace(/```json/g,'').replace(/```/g,'').trim();
  const start = t.indexOf('[') === -1 ? t.indexOf('{') : t.indexOf('[');
  const endChar = t.trimEnd().endsWith(']') ? ']' : '}';
  const end = t.lastIndexOf(endChar);
  if(start>=0 && end>=0) t = t.slice(start, end+1);
  return JSON.parse(t);
}

function fmtBRL(n){
  return (n<0?'-':'') + 'R$ ' + Math.abs(n).toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,'.');
}
function capitalize(s){ return s ? s.charAt(0).toUpperCase()+s.slice(1) : s; }
function initials(name){
  const parts = (name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length>=2) return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
  return (name||'').slice(0,2).toUpperCase();
}

function friendlyErrorMessage(msg){
  const m = (msg||'').toLowerCase();
  if(m.includes('high demand') || m.includes('overloaded') || m.includes('503')){
    return 'O serviço de IA está sobrecarregado agora. Tenta de novo em alguns segundos.';
  }
  if(m.includes('429') || m.includes('rate limit') || m.includes('quota')){
    return 'Muitas tentativas seguidas — espera um pouco e tenta de novo.';
  }
  if(m.includes('timeout') || m.includes('demorou')){
    return 'A IA demorou demais pra responder. Tenta de novo.';
  }
  return msg;
}

// Assinatura pra detectar duplicata: mesma data + descrição (normalizada) + valor
function expenseSignature(date,description,amount){
  return (date||'')+'|'+(description||'').trim().toLowerCase().replace(/\s+/g,' ')+'|'+Number(amount).toFixed(2);
}
function markDuplicates(items, existingExpenses){
  const existingSigs = new Set((existingExpenses||[]).map(e=>expenseSignature(e.date,e.description,e.amount)));
  return items.map(it=>{
    const isDup = existingSigs.has(expenseSignature(it.date,it.description,it.amount));
    return { ...it, duplicate:isDup, include: isDup ? false : it.include };
  });
}

// Segunda checagem: mesma data + valor + cartão/fonte, mas descrição diferente.
// Pode ser a mesma despesa com descrição escrita de outro jeito (ex: editada manualmente antes).
// Não marca automaticamente como duplicata exata — só avisa e deixa o usuário decidir.
function markPossibleDuplicates(items, existingExpenses, card){
  return items.map(it=>{
    if(it.duplicate) return it; // já é duplicata exata, não precisa checar de novo
    const match = (existingExpenses||[]).find(e=>{
      const sameDate = e.date===it.date;
      const sameAmount = Math.abs(Number(e.amount)-Number(it.amount))<0.01;
      const sameCard = (e.card||'').trim().toLowerCase()===(card||'').trim().toLowerCase();
      const diffDesc = (e.description||'').trim().toLowerCase()!==(it.description||'').trim().toLowerCase();
      return sameDate && sameAmount && sameCard && diffDesc;
    });
    if(match) return { ...it, possibleDuplicate:true, matchedDescription:match.description, include:false };
    return it;
  });
}

// Controla quais arquivos já foram importados (por nome+tamanho), guardado no aparelho,
// pra evitar reprocessar o mesmo arquivo se a pasta inteira for selecionada de novo depois.
function loadImportedFilesLog(){
  try{ return JSON.parse(localStorage.getItem('gastos_imported_files')||'[]'); }catch(e){ return []; }
}
function fileLogKey(f){ return f.name+'|'+f.size; }
function isFileAlreadyImported(f, log){ return log.includes(fileLogKey(f)); }
function markFilesImported(files){
  const log = loadImportedFilesLog();
  const keys = new Set(log);
  files.forEach(f=>keys.add(fileLogKey(f)));
  localStorage.setItem('gastos_imported_files', JSON.stringify([...keys]));
}

// Select de cartão/fonte com opção de cadastrar um novo direto ali, sem sair da tela
function CardPicker({client,cards,value,onChange,reloadCards,showToast}){
  const [adding,setAdding] = useState(false);
  const [newName,setNewName] = useState('');
  const [busy,setBusy] = useState(false);

  async function confirmNew(){
    const name = newName.trim();
    if(!name) return;
    if(cards.some(c=>c.toLowerCase()===name.toLowerCase())){
      onChange(cards.find(c=>c.toLowerCase()===name.toLowerCase()));
      setAdding(false); setNewName('');
      return;
    }
    setBusy(true);
    const {error} = await client.from('cards').insert({name});
    setBusy(false);
    if(error){ showToast('Erro: '+error.message); return; }
    await reloadCards();
    onChange(name);
    setAdding(false); setNewName('');
  }

  if(adding){
    return (
      <div className="row2" style={{alignItems:'flex-end'}}>
        <div className="field" style={{marginBottom:0,flex:1}}>
          <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Nome do cartão" onKeyDown={e=>{ if(e.key==='Enter') confirmNew(); }} />
        </div>
        <button className="btn btn-primary btn-sm" style={{flex:'0 0 auto'}} onClick={confirmNew} disabled={busy}>OK</button>
        <button className="btn btn-ghost btn-sm" style={{flex:'0 0 auto'}} onClick={()=>{setAdding(false);setNewName('');}}>Cancelar</button>
      </div>
    );
  }

  return (
    <select value={value} onChange={e=>{
      if(e.target.value==='__new__') setAdding(true);
      else onChange(e.target.value);
    }}>
      <option value="">Sem cartão / não sei</option>
      {value && !cards.includes(value) && <option value={value}>{value}</option>}
      {cards.map(c=><option key={c} value={c}>{c}</option>)}
      <option value="__new__">+ Cadastrar novo cartão…</option>
    </select>
  );
}

// Campo de data: mostra um texto estilizado (nunca estoura o layout) com um
// <input type="date"> nativo invisível por cima só pra abrir o seletor do sistema.
function DateField({value,onChange}){
  const inputRef = useRef();
  function display(){
    if(!value) return 'Selecionar data';
    const d = new Date(value+'T00:00:00');
    return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'});
  }
  return (
    <div style={{position:'relative',overflow:'hidden',borderRadius:6}}>
      <div className="field-display">{display()}</div>
      <input
        ref={inputRef}
        type="date"
        value={value}
        onChange={e=>onChange(e.target.value)}
        style={{position:'absolute',inset:0,width:'100%',height:'100%',opacity:0,margin:0,padding:0,border:'none'}}
      />
    </div>
  );
}

function App(){
  const [cfg,setCfg] = useState(loadCfg());
  const [user,setUser] = useState(localStorage.getItem('gastos_user')||ALL_VIEW);
  const [tab,setTab] = useState('dash');
  const [period,setPeriod] = useState('month');
  const [selectedMonth,setSelectedMonth] = useState(new Date().toISOString().slice(0,7));
  const [selectedYear,setSelectedYear] = useState(String(new Date().getFullYear()));
  const [expenses,setExpenses] = useState([]);
  const [categories,setCategories] = useState([]);
  const [users,setUsers] = useState([]);
  const [cards,setCards] = useState([]);
  const [loading,setLoading] = useState(false);
  const [toast,setToast] = useState(null);
  const client = useMemo(()=>getClient(cfg),[cfg.url,cfg.key]);

  function showToast(msg, duration){ setToast(msg); setTimeout(()=>setToast(null),duration||2600); }

  async function loadExpenses(){
    if(!client) return;
    setLoading(true);
    const {data,error} = await client.from('expenses').select('*').order('date',{ascending:false}).limit(500);
    setLoading(false);
    if(error){ showToast('Erro ao carregar: '+error.message); return; }
    setExpenses(data||[]);
  }

  async function loadCategories(){
    if(!client) return;
    const {data,error} = await client.from('categories').select('*').order('name',{ascending:true});
    if(error){ showToast('Erro ao carregar categorias: '+error.message); return; }
    if((data||[]).length===0){
      // primeira vez: semeia com as categorias padrão
      const seeded = await client.from('categories').insert(DEFAULT_CATEGORIES.map(name=>({name}))).select();
      setCategories(seeded.data || DEFAULT_CATEGORIES.map(name=>({name})));
    } else {
      setCategories(data);
    }
  }

  async function loadUsers(){
    if(!client) return;
    const {data,error} = await client.from('users').select('*').order('created_at',{ascending:true});
    if(error){ showToast('Erro ao carregar usuários: '+error.message); return; }
    let list = data||[];
    if(list.length===0){
      const seeded = await client.from('users').insert(DEFAULT_USERS.map(name=>({name}))).select();
      list = seeded.data || DEFAULT_USERS.map(name=>({name}));
    }
    setUsers(list);
    setUser(prev => prev===ALL_VIEW || (prev && list.some(u=>u.name===prev)) ? prev : (list[0]?.name || ALL_VIEW));
  }

  async function loadCards(){
    if(!client) return;
    const {data,error} = await client.from('cards').select('*').order('name',{ascending:true});
    if(error){ showToast('Erro ao carregar cartões: '+error.message); return; }
    setCards(data||[]);
  }

  useEffect(()=>{ if(client){ loadExpenses(); loadCategories(); loadUsers(); loadCards(); } },[client]);

  function switchUser(u){ setUser(u); localStorage.setItem('gastos_user',u); }

  const catNames = categories.map(c=>c.name);
  const userNames = users.map(u=>u.name);
  const cardNames = cards.map(c=>c.name);

  // Filtro de período
  const now = new Date();
  const todayKey = now.toISOString().slice(0,10);
  const daysAgoKey = (n)=> new Date(now.getTime()-(n-1)*86400000).toISOString().slice(0,10);
  const thisMonthKey = now.toISOString().slice(0,7);
  const thisYear = String(now.getFullYear());

  // Meses e anos que realmente têm despesa lançada (+ o mês/ano atual sempre disponível, mesmo vazio)
  const availableMonths = [...new Set([thisMonthKey, ...expenses.map(e=>(e.date||'').slice(0,7)).filter(Boolean)])].sort().reverse();
  const availableYears = [...new Set([thisYear, ...expenses.map(e=>(e.date||'').slice(0,4)).filter(Boolean)])].sort().reverse();

  function dateMatchesPeriod(d){
    d = d||'';
    if(period==='7d') return d>=daysAgoKey(7) && d<=todayKey;
    if(period==='15d') return d>=daysAgoKey(15) && d<=todayKey;
    if(period==='month') return d.slice(0,7)===selectedMonth;
    if(period==='year') return d.slice(0,4)===selectedYear;
    return true; // 'all'
  }
  const periodExpenses = expenses.filter(e=>dateMatchesPeriod(e.date));
  const periodLabels = {
    '7d':'nos últimos 7 dias',
    '15d':'nos últimos 15 dias',
    month:'em '+capitalize(new Date(selectedMonth+'-02').toLocaleDateString('pt-BR',{month:'long',year:'numeric'})),
    year:'em '+selectedYear,
    all:'no total'
  };

  // Categorias marcadas como "crédito" (ex: Pagamento Efetuado) não contam como despesa —
  // são pagamentos/estornos, não gasto. Ficam de fora das somas, mostradas à parte.
  const creditCategoryNames = categories.filter(c=>c.is_credit).map(c=>c.name);
  const isCreditExpense = (e)=>creditCategoryNames.includes(e.category);

  // Quando um usuário específico está selecionado (não "Todos"), filtra tudo por ele
  const viewExpensesAll = user!==ALL_VIEW ? periodExpenses.filter(e=>e.added_by===user) : periodExpenses;
  const viewExpenses = viewExpensesAll.filter(e=>!isCreditExpense(e));
  const viewExpensesCredit = viewExpensesAll.filter(e=>isCreditExpense(e));

  const periodTotal = viewExpenses.reduce((s,e)=>s+Number(e.amount),0);
  const byUser = {};
  periodExpenses.filter(e=>!isCreditExpense(e)).forEach(e=>{ byUser[e.added_by] = (byUser[e.added_by]||0)+Number(e.amount); });

  const byCat = {};
  viewExpenses.forEach(e=>{ byCat[e.category||'Outros'] = (byCat[e.category||'Outros']||0)+Number(e.amount); });
  const catList = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const maxCat = catList.length ? catList[0][1] : 1;

  // Créditos/pagamentos ficam numa lista separada, mostrada no final, sem entrar na soma acima
  const byCreditCat = {};
  viewExpensesCredit.forEach(e=>{ byCreditCat[e.category||'Outros'] = (byCreditCat[e.category||'Outros']||0)+Number(e.amount); });
  const creditCatList = Object.entries(byCreditCat).sort((a,b)=>b[1]-a[1]);
  const creditTotal = viewExpensesCredit.reduce((s,e)=>s+Number(e.amount),0);

  const byCard = {};
  viewExpenses.forEach(e=>{ byCard[e.card||'Sem cartão/fonte'] = (byCard[e.card||'Sem cartão/fonte']||0)+Number(e.amount); });
  const cardList = Object.entries(byCard).sort((a,b)=>b[1]-a[1]);
  const maxCard = cardList.length ? cardList[0][1] : 1;

  // Agrupa por descrição (mesma loja/despesa) pra achar recorrências e acumulado
  const byDesc = {};
  viewExpenses.forEach(e=>{
    const key = (e.description||'Sem descrição').trim().toLowerCase();
    if(!byDesc[key]) byDesc[key] = { label: e.description||'Sem descrição', total:0, count:0 };
    byDesc[key].total += Number(e.amount);
    byDesc[key].count += 1;
  });
  const descList = Object.values(byDesc).sort((a,b)=>b.total-a.total);
  const maxDesc = descList.length ? descList[0].total : 1;

  const listExpenses = viewExpensesAll;

  if(!client){
    return <ConfigScreen cfg={cfg} onSave={(c)=>{saveCfg(c);setCfg(c);}} />;
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Expense Flow</div>
        {userNames.length>1 && (
          <div className="who">
            <button className={user===ALL_VIEW?'active':''} onClick={()=>switchUser(ALL_VIEW)} title="Todos">TD</button>
            {userNames.map(u=>(
              <button key={u} className={user===u?'active':''} onClick={()=>switchUser(u)} title={u}>{initials(u)}</button>
            ))}
          </div>
        )}
        <div className="hero-num">{fmtBRL(periodTotal)}</div>
        <div className="hero-label">gasto {user!==ALL_VIEW ? 'de '+user+' ' : 'total '}{periodLabels[period]}</div>
        <div className="period-picker">
          <button className={period==='7d'?'active':''} onClick={()=>setPeriod('7d')}>7 dias</button>
          <button className={period==='15d'?'active':''} onClick={()=>setPeriod('15d')}>15 dias</button>
          <button className={period==='month'?'active':''} onClick={()=>setPeriod('month')}>Mês</button>
          <button className={period==='year'?'active':''} onClick={()=>setPeriod('year')}>Ano</button>
          <button className={period==='all'?'active':''} onClick={()=>setPeriod('all')}>Tudo</button>
        </div>
        {period==='month' && (
          <select className="period-subselect" value={selectedMonth} onChange={ev=>setSelectedMonth(ev.target.value)}>
            {availableMonths.map(m=>(
              <option key={m} value={m}>{capitalize(new Date(m+'-02').toLocaleDateString('pt-BR',{month:'long',year:'numeric'}))}</option>
            ))}
          </select>
        )}
        {period==='year' && (
          <select className="period-subselect" value={selectedYear} onChange={ev=>setSelectedYear(ev.target.value)}>
            {availableYears.map(y=><option key={y} value={y}>{y}</option>)}
          </select>
        )}
        {userNames.length>1 && (
          <div className="hero-split">
            {userNames.map(u=>(
              <div key={u}><span>{u}</span>{fmtBRL(byUser[u]||0)}</div>
            ))}
          </div>
        )}
      </div>

      <div className="content">
        {tab==='dash' && <Dashboard catList={catList} maxCat={maxCat} cardList={cardList} maxCard={maxCard} descList={descList} maxDesc={maxDesc} periodTotal={periodTotal} creditCatList={creditCatList} creditTotal={creditTotal} cards={cards} client={client} reloadCards={loadCards} reload={loadExpenses} showToast={showToast} />}
        {tab==='list' && <ListTab expenses={listExpenses} totalCount={expenses.length} periodLabel={periodLabels[period]} dateMatchesPeriod={dateMatchesPeriod} loading={loading} client={client} categories={catNames} users={userNames} cards={cardNames} reload={loadExpenses} showToast={showToast} />}
        {tab==='proj' && <ProjectionTab expenses={expenses} client={client} reload={loadExpenses} showToast={showToast} />}
        {tab==='addimport' && <AddOrImportTab client={client} user={user===ALL_VIEW ? (userNames[0]||'') : user} categories={catNames} users={userNames} cards={cardNames} reloadCards={loadCards} expenses={expenses} reload={loadExpenses} showToast={showToast} setTab={setTab} />}
        {tab==='payables' && <PayablesTab client={client} cards={cards} users={userNames} expenses={expenses} reload={loadExpenses} showToast={showToast} />}
        {tab==='cfg' && <ConfigScreen cfg={cfg} onSave={(c)=>{saveCfg(c);setCfg(c);}} embedded categories={categories} users={users} cards={cards} client={client} reloadCategories={loadCategories} reloadUsers={loadUsers} reloadCards={loadCards} reloadExpenses={loadExpenses} showToast={showToast} />}
      </div>

      <div className="tabs">
        <button className={tab==='dash'?'active':''} onClick={()=>setTab('dash')}><span className="tab-icon">📊</span>Resumo</button>
        <button className={tab==='list'?'active':''} onClick={()=>setTab('list')}><span className="tab-icon">📋</span>Lanç.</button>
        <button className={tab==='proj'?'active':''} onClick={()=>setTab('proj')}><span className="tab-icon">🔁</span>Projeção</button>
        <button className={tab==='addimport'?'active':''} onClick={()=>setTab('addimport')}><span className="tab-icon">➕</span>Adicionar</button>
        <button className={tab==='payables'?'active':''} onClick={()=>setTab('payables')}><span className="tab-icon">💰</span>A Pagar</button>
        <button className={tab==='cfg'?'active':''} onClick={()=>setTab('cfg')}><span className="tab-icon">⚙️</span>Config</button>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Dashboard({catList,maxCat,cardList,maxCard,descList,maxDesc,periodTotal,creditCatList,creditTotal,cards,client,reloadCards,reload,showToast}){
  const [syncing,setSyncing] = useState(false);
  const [balances,setBalances] = useState([]);
  const [editingManualId,setEditingManualId] = useState(null);
  const [manualDraft,setManualDraft] = useState({limit:'',balance:''});
  const [savingManual,setSavingManual] = useState(false);
  const [pendingReview,setPendingReview] = useState([]);
  const [reviewChecks,setReviewChecks] = useState({}); // id -> bool (marcado pra importar)
  const [confirmingReview,setConfirmingReview] = useState(false);

  async function loadBalances(){
    try{
      const res = await fetch('/api/plaid-status');
      const data = await res.json();
      if(!res.ok) return;
      setBalances(data.connections||[]);
    }catch(e){ /* Plaid ainda não configurado, ignora */ }
  }
  async function loadPendingReview(){
    if(!client) return;
    const {data,error} = await client.from('plaid_pending_transactions').select('*').order('date',{ascending:false});
    if(!error) setPendingReview(data||[]);
  }
  useEffect(()=>{ loadBalances(); loadPendingReview(); },[]);

  async function confirmReview(){
    setConfirmingReview(true);
    const toImport = pendingReview.filter(p=>reviewChecks[p.id]);
    const toDiscard = pendingReview.filter(p=>!reviewChecks[p.id]);
    if(toImport.length>0){
      const rows = toImport.map(p=>({
        description:p.description, amount:p.amount, category:p.category,
        card:p.card, date:p.date, added_by:p.added_by, source:'plaid'
      }));
      const {error} = await client.from('expenses').insert(rows);
      if(error){ setConfirmingReview(false); showToast('Erro: '+error.message); return; }
    }
    const allIds = pendingReview.map(p=>p.id);
    if(allIds.length>0){
      await client.from('plaid_pending_transactions').delete().in('id',allIds);
    }
    setConfirmingReview(false);
    showToast(toImport.length+' importada(s), '+toDiscard.length+' descartada(s) ✓');
    setReviewChecks({});
    loadPendingReview();
    if(reload) reload();
  }

  async function syncAll(){
    setSyncing(true);
    try{
      const res = await fetch('/api/plaid-sync-all', { method:'POST' });
      const data = await res.json();
      setSyncing(false);
      if(!res.ok){ showToast('Erro ao sincronizar: '+(data.error||'')); return; }
      if(data.results.length===0){ showToast('Nenhum cartão conectado ao Plaid ainda'); return; }
      const pendingMsg = data.totalPending>0 ? `, ${data.totalPending} pendente(s) de revisão` : '';
      showToast(data.totalImported+' nova(s) despesa(s) importada(s)'+pendingMsg+(data.hadErrors?' (algum cartão deu erro)':'')+' ✓');
      if(reload) reload();
      loadBalances();
      if(loadPendingReview) loadPendingReview();
    }catch(e){
      setSyncing(false);
      showToast('Erro ao sincronizar: '+e.message);
    }
  }

  function startManualEdit(c){
    setEditingManualId(c.id);
    setManualDraft({ limit: c.manual_limit!=null?String(c.manual_limit):'', balance: c.manual_balance!=null?String(c.manual_balance):'' });
  }

  async function saveManual(cardId){
    setSavingManual(true);
    const limit = manualDraft.limit ? parseFloat(String(manualDraft.limit).replace(',','.')) : null;
    const balance = manualDraft.balance ? parseFloat(String(manualDraft.balance).replace(',','.')) : null;
    const {error} = await client.from('cards').update({
      manual_limit: limit, manual_balance: balance, manual_balance_updated_at: new Date().toISOString()
    }).eq('id',cardId);
    setSavingManual(false);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast('Saldo/limite atualizado ✓');
    setEditingManualId(null);
    if(reloadCards) reloadCards();
  }

  async function setAccountType(cardId, type){
    const {error} = await client.from('cards').update({ account_type: type }).eq('id',cardId);
    if(error){ showToast('Erro: '+error.message); return; }
    if(reloadCards) reloadCards();
  }

  const balanceMap = {};
  balances.forEach(b=>{ balanceMap[b.card_id] = b; });

  function isStale(timestamp){
    if(!timestamp) return false;
    const diffMs = Date.now() - new Date(timestamp).getTime();
    return diffMs >= 3*24*60*60*1000;
  }

  function renderCardRow(c){
    const b = balanceMap[c.id];
    const connected = !!b && b.status==='connected';
    const isCredit = (c.account_type||'credit')==='credit';
    const plaidHasData = isCredit
      ? (connected && b.credit_limit!=null && (b.available_balance!=null || b.current_balance!=null))
      : (connected && (b.available_balance!=null || b.current_balance!=null));
    const hasManual = isCredit ? (c.manual_limit!=null && c.manual_balance!=null) : (c.manual_balance!=null);
    const hasData = plaidHasData || hasManual;
    const dotColor = hasData ? 'var(--green)' : 'var(--red)';
    const manualAvailable = isCredit && hasManual ? (c.manual_limit - c.manual_balance) : c.manual_balance;
    const isEditing = editingManualId===c.id;
    const showManualLink = !plaidHasData;

    return (
      <div key={c.id} style={{padding:'10px 2px',borderBottom:'1px dashed var(--bezel)'}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:connected?2:6}}>
          <span style={{width:7,height:7,borderRadius:'50%',background:dotColor,display:'inline-block',flexShrink:0}}></span>
          <span className="ledger-desc" style={{flex:1}}>{c.name}</span>
          <select value={c.account_type||'credit'} onChange={ev=>setAccountType(c.id,ev.target.value)} style={{width:'auto',padding:'3px 6px',fontSize:10.5}}>
            <option value="credit">Crédito</option>
            <option value="bank">Conta</option>
          </select>
        </div>
        {connected && (
          <div style={{marginBottom:6}}>
            <span style={{display:'inline-block',fontSize:9.5,fontWeight:800,letterSpacing:'0.03em',padding:'2px 8px',borderRadius:20,background:'var(--green)',color:'#fff'}}>PLAID</span>
          </div>
        )}

        {!isEditing && (
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end'}}>
            <div className="ledger-meta">
              {plaidHasData && isCredit && <>Disponível: <b style={{color:'var(--green)'}}>{fmtBRL(b.available_balance||0)}</b> de {fmtBRL(b.credit_limit)}</>}
              {plaidHasData && !isCredit && <>Saldo disponível</>}
              {!plaidHasData && hasManual && isCredit && <>Disponível: <b style={{color:'var(--amber)'}}>{fmtBRL(manualAvailable)}</b> de {fmtBRL(c.manual_limit)}</>}
              {!plaidHasData && hasManual && !isCredit && <>Saldo (manual)</>}
              {!plaidHasData && !hasManual && <>Sem dados de saldo{isCredit?'/limite':''} ainda</>}
            </div>
            <div style={{textAlign:'right'}}>
              {(plaidHasData || hasManual) && (
                <div className="ledger-amt" style={{color: isCredit ? 'var(--amber)' : 'var(--green)'}}>
                  {plaidHasData
                    ? fmtBRL(isCredit ? (b.current_balance||0) : (b.available_balance||b.current_balance||0))
                    : fmtBRL(isCredit ? c.manual_balance : c.manual_balance)}
                </div>
              )}
              {showManualLink && (
                <span className="link" onClick={()=>startManualEdit(c)}>{hasManual?'editar':'+ adicionar'}</span>
              )}
              {plaidHasData && b.balance_updated_at && (
                <div className={isStale(b.balance_updated_at) ? undefined : "muted"} style={{fontSize:9.5,marginTop:2,color:isStale(b.balance_updated_at)?'var(--red)':undefined}}>
                  atualizado {new Date(b.balance_updated_at).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}
                </div>
              )}
              {!plaidHasData && hasManual && c.manual_balance_updated_at && (
                <div className={isStale(c.manual_balance_updated_at) ? undefined : "muted"} style={{fontSize:9.5,marginTop:2,color:isStale(c.manual_balance_updated_at)?'var(--red)':undefined}}>
                  atualizado {new Date(c.manual_balance_updated_at).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}
                </div>
              )}
            </div>
          </div>
        )}

        {isEditing && (
          <div>
            <div className="row2" style={{marginBottom:8}}>
              {isCredit && (
                <div className="field" style={{marginBottom:0}}>
                  <label>Limite total</label>
                  <input value={manualDraft.limit} onChange={ev=>setManualDraft({...manualDraft,limit:ev.target.value})} placeholder="0,00" inputMode="decimal" />
                </div>
              )}
              <div className="field" style={{marginBottom:0}}>
                <label>{isCredit ? 'Saldo em aberto' : 'Saldo disponível'}</label>
                <input value={manualDraft.balance} onChange={ev=>setManualDraft({...manualDraft,balance:ev.target.value})} placeholder="0,00" inputMode="decimal" />
              </div>
            </div>
            {isCredit && (
              <p className="muted" style={{marginBottom:8}}>Disponível calculado: <b>{manualDraft.limit && manualDraft.balance ? fmtBRL(parseFloat(manualDraft.limit.replace(',','.'))-parseFloat(manualDraft.balance.replace(',','.'))) : '—'}</b></p>
            )}
            <div className="row2">
              <button className="btn btn-ghost btn-sm" onClick={()=>setEditingManualId(null)} disabled={savingManual}>Cancelar</button>
              <button className="btn btn-primary btn-sm" onClick={()=>saveManual(c.id)} disabled={savingManual}>{savingManual?'Salvando…':'Salvar'}</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function cardFigures(c){
    const b = balanceMap[c.id];
    const connected = !!b && b.status==='connected';
    const isCredit = (c.account_type||'credit')==='credit';
    const plaidHasData = isCredit
      ? (connected && b.credit_limit!=null && (b.available_balance!=null || b.current_balance!=null))
      : (connected && (b.available_balance!=null || b.current_balance!=null));
    const hasManual = isCredit ? (c.manual_limit!=null && c.manual_balance!=null) : (c.manual_balance!=null);
    if(isCredit){
      if(plaidHasData) return { limit:b.credit_limit||0, owed:b.current_balance||0, available:b.available_balance||0, hasData:true };
      if(hasManual) return { limit:c.manual_limit||0, owed:c.manual_balance||0, available:(c.manual_limit-c.manual_balance)||0, hasData:true };
      return { limit:0, owed:0, available:0, hasData:false };
    }
    if(plaidHasData) return { balance:(b.available_balance||b.current_balance||0), hasData:true };
    if(hasManual) return { balance:c.manual_balance||0, hasData:true };
    return { balance:0, hasData:false };
  }

  const creditCards = (cards||[]).filter(c=>(c.account_type||'credit')==='credit');
  const bankCards = (cards||[]).filter(c=>c.account_type==='bank');

  const creditTotals = creditCards.reduce((acc,c)=>{
    const f = cardFigures(c);
    if(f.hasData){ acc.limit+=f.limit; acc.owed+=f.owed; acc.available+=f.available; }
    return acc;
  }, {limit:0,owed:0,available:0});

  const bankTotal = bankCards.reduce((acc,c)=>{
    const f = cardFigures(c);
    if(f.hasData) acc += f.balance;
    return acc;
  }, 0);

  return (
    <div>
      <button className="btn btn-ghost" style={{marginBottom:16}} onClick={syncAll} disabled={syncing}>
        {syncing ? <span className="spinner"></span> : '🔄 Sincronizar tudo (Plaid)'}
      </button>

      {pendingReview.length>0 && (
        <>
          <div className="section-title">⚠️ {pendingReview.length} transação(ões) do Plaid pra revisar</div>
          <div className="card" style={{borderColor:'var(--red)'}}>
            <p className="muted" style={{marginBottom:12}}>Pareciam duplicatas de algo já lançado (mesma data, valor e cartão, descrição diferente). Marca as que forem despesas de verdade diferentes — o resto é descartado.</p>
            {pendingReview.map(p=>(
              <div className="rev-row" key={p.id}>
                <div className="r1">
                  <label style={{display:'flex',gap:8,alignItems:'center'}}>
                    <input type="checkbox" checked={!!reviewChecks[p.id]} onChange={e=>setReviewChecks({...reviewChecks,[p.id]:e.target.checked})} />
                    {p.description}
                  </label>
                  <span style={{fontFamily:'JetBrains Mono, monospace'}}>{fmtBRL(Number(p.amount))}</span>
                </div>
                <p className="muted" style={{marginTop:4,marginBottom:0,fontSize:11.5}}>
                  Parece com <b>"{p.matched_description}"</b> já lançada em {new Date(p.date).toLocaleDateString('pt-BR')}{p.card?' no '+p.card:''}.
                </p>
              </div>
            ))}
            <button className="btn btn-primary" style={{marginTop:8}} onClick={confirmReview} disabled={confirmingReview}>
              {confirmingReview ? <span className="spinner"></span> : 'Confirmar (importa marcadas, descarta o resto)'}
            </button>
          </div>
        </>
      )}

      <div className="section-title">Por categoria</div>
      <div className="card">
        {catList.length===0 && <div className="empty"><span className="big">🗒️</span>Nenhum gasto nesse período.</div>}
        {catList.map(([cat,val])=>(
          <div className="cat-bar-wrap" key={cat}>
            <div className="cat-bar-top"><span>{cat}</span><b>{fmtBRL(val)}</b></div>
            <div className="cat-bar-track"><div className="cat-bar-fill" style={{width:(val/maxCat*100)+'%'}}></div></div>
          </div>
        ))}
      </div>

      <div className="section-title">Por cartão / fonte</div>
      <div className="card">
        {cardList.length===0 && <div className="empty"><span className="big">💳</span>Nenhum gasto nesse período.</div>}
        {cardList.map(([card,val])=>(
          <div className="cat-bar-wrap" key={card}>
            <div className="cat-bar-top"><span>{card}</span><b>{fmtBRL(val)}</b></div>
            <div className="cat-bar-track"><div className="cat-bar-fill" style={{width:(val/maxCard*100)+'%'}}></div></div>
          </div>
        ))}
      </div>

      {creditCards.length>0 && (
        <>
          <div className="section-title">💳 Cartões de Crédito</div>
          <div className="card">
            {creditCards.map(renderCardRow)}
            <div style={{padding:'12px 2px 2px',marginTop:4}}>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
                <span className="muted">Limite total</span><b style={{fontFamily:'JetBrains Mono, monospace'}}>{fmtBRL(creditTotals.limit)}</b>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
                <span className="muted">Saldo em aberto total</span><b style={{fontFamily:'JetBrains Mono, monospace',color:'var(--amber)'}}>{fmtBRL(creditTotals.owed)}</b>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:12}}>
                <span className="muted">Disponível total</span><b style={{fontFamily:'JetBrains Mono, monospace',color:'var(--green)'}}>{fmtBRL(creditTotals.available)}</b>
              </div>
            </div>
          </div>
        </>
      )}

      {bankCards.length>0 && (
        <>
          <div className="section-title">🏦 Contas Bancárias</div>
          <div className="card">
            {bankCards.map(renderCardRow)}
            <div style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'12px 2px 2px',marginTop:4}}>
              <span className="muted">Saldo total</span><b style={{fontFamily:'JetBrains Mono, monospace',color:'var(--green)'}}>{fmtBRL(bankTotal)}</b>
            </div>
          </div>
        </>
      )}

      <div className="section-title">Por despesa (recorrentes)</div>
      <div className="card">
        {descList.filter(d=>d.count>1).length===0 && <div className="empty"><span className="big">🔁</span>Nenhuma despesa repetida nesse período.</div>}
        {descList.filter(d=>d.count>1).map(d=>(
          <div className="cat-bar-wrap" key={d.label}>
            <div className="cat-bar-top"><span>{d.label} <span className="tag" style={{marginLeft:4}}>{d.count}x</span></span><b>{fmtBRL(d.total)}</b></div>
            <div className="cat-bar-track"><div className="cat-bar-fill" style={{width:(d.total/maxDesc*100)+'%'}}></div></div>
          </div>
        ))}
      </div>

      {creditCatList && creditCatList.length>0 && (
        <>
          <div className="section-title">💳 Pagamentos / Créditos</div>
          <div className="card">
            <p className="muted" style={{marginBottom:10}}>Não entram na soma de despesas acima — são pagamentos/estornos, não gasto.</p>
            {creditCatList.map(([cat,val])=>(
              <div className="ledger-row" key={cat}>
                <div className="ledger-desc">{cat}</div>
                <div className="ledger-amt" style={{color:'var(--green)'}}>{fmtBRL(val)}</div>
              </div>
            ))}
            <div style={{display:'flex',justifyContent:'space-between',fontSize:12,paddingTop:10,marginTop:4,borderTop:'1px dashed var(--bezel)'}}>
              <span className="muted">Total em créditos</span><b style={{fontFamily:'JetBrains Mono, monospace',color:'var(--green)'}}>{fmtBRL(creditTotal)}</b>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ProjectionTab({expenses,client,reload,showToast}){
  const [refreshing,setRefreshing] = useState(false);
  const [removingKey,setRemovingKey] = useState(null);
  const [sortBy,setSortBy] = useState('date');

  async function refresh(){
    setRefreshing(true);
    if(reload) await reload();
    setRefreshing(false);
  }

  // Agrupa todas as despesas marcadas como recorrente por descrição + valor, ficando com a
  // ocorrência mais recente de cada uma (usada como valor previsto pro próximo mês).
  // Usa valor também porque comerciantes como a Apple reusam a mesma descrição genérica
  // ("APPLE.COM/BILL") pra várias assinaturas diferentes (Music, iCloud, TV+, etc.) —
  // só descrição juntaria assinaturas diferentes numa única linha.
  function recKey(e){ return (e.description||'').trim().toLowerCase()+'|'+Number(e.amount).toFixed(2); }
  const recurringMap = {};
  expenses.filter(e=>e.is_recurring).forEach(e=>{
    const key = recKey(e);
    if(!recurringMap[key] || e.date>recurringMap[key].date) recurringMap[key] = e;
  });
  const recurringList = Object.entries(recurringMap)
    .map(([key,e])=>({key,...e}))
    .sort((a,b)=>{
      if(sortBy==='category') return (a.category||'Outros').localeCompare(b.category||'Outros') || Number(b.amount)-Number(a.amount);
      // 'date': ordena pelo DIA do mês (vence primeiro no mês vem primeiro), ignora mês/ano
      const dayA = parseInt((a.date||'').slice(8,10),10) || 0;
      const dayB = parseInt((b.date||'').slice(8,10),10) || 0;
      return dayA - dayB;
    });
  const projectedTotal = recurringList.reduce((s,e)=>s+Number(e.amount),0);

  // Tira da projeção sem apagar nenhum lançamento — desmarca "recorrente" em TODAS as
  // ocorrências passadas com essa mesma descrição+valor, pra parar de contar pro futuro
  // (uso: foi cancelada, ou essa foi a última vez que teve).
  async function removeFromProjection(key,description){
    setRemovingKey(key);
    const matchIds = expenses.filter(e=>recKey(e)===key).map(e=>e.id);
    const {error} = await client.from('expenses').update({ is_recurring:false }).in('id', matchIds);
    setRemovingKey(null);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast('"'+description+'" removida da projeção ✓');
    if(reload) reload();
  }

  return (
    <div>
      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:12}}>
        <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={refreshing}>
          {refreshing ? <span className="spinner"></span> : '🔄 Atualizar'}
        </button>
      </div>
      <div className="card" style={{textAlign:'center',padding:'22px 16px'}}>
        <div className="muted" style={{textTransform:'uppercase',fontSize:11,letterSpacing:'0.06em',marginBottom:6}}>Gastos fixos por mês</div>
        <div className="hero-num" style={{fontSize:36}}>{fmtBRL(projectedTotal)}</div>
        <div className="muted" style={{marginTop:4,fontSize:12}}>com base em {recurringList.length} despesa{recurringList.length!==1?'s':''} marcada{recurringList.length!==1?'s':''} como recorrente</div>
      </div>

      <p className="muted" style={{marginBottom:12}}>Toda despesa marcada com 🔁 "recorrente" (em "+ Gasto" ou editando um lançamento) aparece aqui automaticamente. Se alguma parou de valer — foi cancelada, ou essa foi a última vez — usa "remover" pra tirar da lista sem apagar o histórico.</p>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <div className="section-title" style={{margin:0}}>Fixas ({recurringList.length})</div>
        <select value={sortBy} onChange={ev=>setSortBy(ev.target.value)} style={{width:'auto',padding:'6px 8px',fontSize:12.5}}>
          <option value="date">Ordenar: Dia do mês</option>
          <option value="category">Ordenar: Categoria</option>
        </select>
      </div>
      <div className="card">
        {recurringList.length===0 && <div className="empty"><span className="big">🔁</span>Nenhuma despesa marcada como recorrente ainda. Marca uma em "+ Gasto" ou editando um lançamento.</div>}
        {recurringList.map(e=>(
          <div className="ledger-row" key={e.key}>
            <div>
              <div className="ledger-desc">{e.description}</div>
              <div className="ledger-meta">
                <span className="tag">{e.category||'Outros'}</span>
                {e.card && <span className="tag">{e.card}</span>}
                última vez: {new Date(e.date).toLocaleDateString('pt-BR')}
              </div>
            </div>
            <div style={{textAlign:'right'}}>
              <div className="ledger-amt">{fmtBRL(Number(e.amount))}</div>
              <span className="link" style={{color:'var(--red)'}} onClick={()=>removeFromProjection(e.key,e.description)}>
                {removingKey===e.key ? <span className="spinner"></span> : 'remover'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ListTab({expenses,totalCount,periodLabel,dateMatchesPeriod,loading,client,categories,users,cards,reload,showToast}){
  const [confirmingClear,setConfirmingClear] = useState(false);
  const [clearing,setClearing] = useState(false);
  const [editingId,setEditingId] = useState(null);
  const [draft,setDraft] = useState(null);
  const [saving,setSaving] = useState(false);
  const [cardFilter,setCardFilter] = useState('');
  const [categoryFilter,setCategoryFilter] = useState('');
  const [searchText,setSearchText] = useState('');
  const [selectMode,setSelectMode] = useState(false);
  const [selectedIds,setSelectedIds] = useState([]);
  const [confirmingDeleteId,setConfirmingDeleteId] = useState(null);
  const [deletingSelected,setDeletingSelected] = useState(false);

  function toggleSelect(id){
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  }

  function exitSelectMode(){
    setSelectMode(false);
    setSelectedIds([]);
  }

  async function deleteSelected(){
    setDeletingSelected(true);
    const {error} = await client.from('expenses').delete().in('id', selectedIds);
    setDeletingSelected(false);
    if(error){ showToast('Erro ao apagar: '+error.message); return; }
    showToast(selectedIds.length+' lançamento(s) apagado(s) ✓');
    exitSelectMode();
    reload();
  }

  async function del(id){
    const {error} = await client.from('expenses').delete().eq('id',id);
    if(error){ showToast('Erro ao apagar'); return; }
    setConfirmingDeleteId(null);
    reload();
  }

  function startEdit(e){
    setEditingId(e.id);
    setDraft({
      description: e.description||'',
      amount: String(e.amount),
      date: (e.date||'').slice(0,10),
      category: e.category||'',
      card: e.card||'',
      added_by: e.added_by||'',
      isRecurring: !!e.is_recurring,
      applyToAll: false,
      applyDescToAll: false,
      applyRecurringToAll: false
    });
  }

  async function saveEdit(id, originalDescription, originalCategory){
    if(!draft.description.trim() || !draft.amount){ showToast('Preencha descrição e valor'); return; }
    setSaving(true);
    const newDescription = draft.description.trim();
    const {error} = await client.from('expenses').update({
      description: newDescription,
      amount: parseFloat(String(draft.amount).replace(',','.')),
      date: draft.date,
      category: draft.category || 'Outros',
      card: draft.card || null,
      added_by: draft.added_by,
      is_recurring: draft.isRecurring
    }).eq('id',id);
    if(error){ setSaving(false); showToast('Erro: '+error.message); return; }

    const categoryChanged = draft.applyToAll && draft.category && draft.category!==originalCategory;
    const descChanged = draft.applyDescToAll && newDescription!==(originalDescription||'').trim();
    let bulkCount = 0;
    if(categoryChanged || descChanged || draft.applyRecurringToAll){
      const key = (originalDescription||'').trim().toLowerCase();
      const matchIds = expenses.filter(x=>x.id!==id && (x.description||'').trim().toLowerCase()===key).map(x=>x.id);
      if(matchIds.length>0){
        const bulkUpdate = {};
        if(categoryChanged) bulkUpdate.category = draft.category || 'Outros';
        if(descChanged) bulkUpdate.description = newDescription;
        if(draft.applyRecurringToAll) bulkUpdate.is_recurring = draft.isRecurring;
        const {error:bulkError} = await client.from('expenses').update(bulkUpdate).in('id',matchIds);
        if(!bulkError) bulkCount = matchIds.length;
      }
    }

    setSaving(false);
    const stillVisible = !dateMatchesPeriod || dateMatchesPeriod(draft.date);
    const baseMsg = 'Lançamento atualizado'+(bulkCount>0?' + '+bulkCount+' outro(s) igual(is)':'')+' ✓';
    showToast(stillVisible ? baseMsg : baseMsg+' — saiu do filtro de período ativo (troca pra "Tudo" pra ver)', stillVisible?2600:4500);
    setEditingId(null); setDraft(null);
    reload();
  }

  async function clearAll(){
    setClearing(true);
    const ids = filteredExpenses.map(e=>e.id);
    const {error} = await client.from('expenses').delete().in('id', ids);
    setClearing(false);
    setConfirmingClear(false);
    if(error){ showToast('Erro ao limpar: '+error.message); return; }
    showToast(ids.length+' lançamento(s) apagado(s)');
    reload();
  }

  // Agrupa por mês (a lista já vem ordenada por data desc do Supabase)
  const filteredExpenses = expenses
    .filter(e => cardFilter ? (e.card||'Sem cartão/fonte')===cardFilter : true)
    .filter(e => categoryFilter ? (e.category||'Outros')===categoryFilter : true)
    .filter(e => {
      if(!searchText.trim()) return true;
      const q = searchText.trim().toLowerCase();
      return (e.description||'').toLowerCase().includes(q)
        || (e.category||'').toLowerCase().includes(q)
        || (e.card||'').toLowerCase().includes(q)
        || (e.added_by||'').toLowerCase().includes(q);
    });
  const groups = [];
  let currentKey = null, currentGroup = null;
  filteredExpenses.forEach(e=>{
    const key = (e.date||'').slice(0,7);
    if(key!==currentKey){
      currentKey = key;
      currentGroup = { key, label: key ? capitalize(new Date(key+'-02').toLocaleDateString('pt-BR',{month:'long',year:'numeric'})) : 'Sem data', items: [], total:0 };
      groups.push(currentGroup);
    }
    currentGroup.items.push(e);
    currentGroup.total += Number(e.amount);
  });

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <div className="section-title" style={{margin:0}}>Lançamentos</div>
        <div style={{display:'flex',gap:14,alignItems:'center'}}>
          {!selectMode && totalCount>0 && !confirmingClear && (
            <>
              <span className="link" onClick={()=>setSelectMode(true)}>Selecionar</span>
              <span className="link" style={{color:'var(--red)'}} onClick={()=>setConfirmingClear(true)}>Limpar seleção</span>
            </>
          )}
          {selectMode && (
            <>
              {selectedIds.length>0 && (
                <span className="link" style={{color:'var(--red)'}} onClick={deleteSelected}>
                  {deletingSelected ? <span className="spinner"></span> : `Apagar (${selectedIds.length})`}
                </span>
              )}
              <span className="link" onClick={exitSelectMode}>Cancelar</span>
            </>
          )}
        </div>
      </div>
      {(cards.length>0 || categories.length>0) && (
        <div className="row2" style={{marginBottom:14}}>
          {cards.length>0 && (
            <select value={cardFilter} onChange={ev=>setCardFilter(ev.target.value)} style={{flex:1,minWidth:0}}>
              <option value="">Todos os cartões / fontes</option>
              {cards.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {categories.length>0 && (
            <select value={categoryFilter} onChange={ev=>setCategoryFilter(ev.target.value)} style={{flex:1,minWidth:0}}>
              <option value="">Todas as categorias</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      )}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <span style={{fontSize:16,flexShrink:0}}>🔍</span>
        <input
          value={searchText}
          onChange={ev=>setSearchText(ev.target.value)}
          placeholder="Buscar por descrição, categoria, cartão ou responsável…"
          style={{flex:1}}
        />
      </div>
      {confirmingClear && (
        <div className="card" style={{borderColor:'var(--red)'}}>
          <div style={{fontWeight:700,marginBottom:6,color:'var(--red)'}}>⚠️ Apagar os lançamentos filtrados?</div>
          <div style={{background:'var(--bg)',border:'1px solid var(--bezel)',borderRadius:6,padding:'8px 10px',marginBottom:10,fontSize:12.5}}>
            <div><b>Período:</b> {periodLabel || 'todo o período'}</div>
            <div><b>Cartão/fonte:</b> {cardFilter || 'todos'}</div>
            <div><b>Categoria:</b> {categoryFilter || 'todas'}</div>
            {searchText.trim() && <div><b>Busca:</b> "{searchText.trim()}"</div>}
          </div>
          <p className="muted" style={{marginBottom:14}}>
            Isso vai excluir permanentemente <b>{filteredExpenses.length} lançamento(s)</b> que batem com esse filtro. Os outros {totalCount-filteredExpenses.length} fora do filtro não são afetados. Não tem como desfazer.
          </p>
          <div className="row2">
            <button className="btn btn-ghost" onClick={()=>setConfirmingClear(false)} disabled={clearing}>Cancelar</button>
            <button className="btn btn-primary" style={{background:'var(--red)',color:'#fff'}} onClick={clearAll} disabled={clearing}>
              {clearing ? <span className="spinner"></span> : 'Sim, apagar'}
            </button>
          </div>
        </div>
      )}
      {loading && <div className="empty">Carregando…</div>}
      {!loading && filteredExpenses.length===0 && (
        <div className="empty"><span className="big">📭</span>{(cardFilter||categoryFilter||searchText.trim()) ? 'Nenhum lançamento com esse filtro.' : 'Nada lançado ainda.'}</div>
      )}
      {groups.map(g=>(
        <div key={g.key}>
          <div className="month-divider">
            <span>{g.label}</span>
            <span>{fmtBRL(g.total)}</span>
          </div>
          <div className="card ledger">
            {g.items.map(e=>{
              if(editingId===e.id){
                const key = (e.description||'').trim().toLowerCase();
                const siblingCount = expenses.filter(x=>x.id!==e.id && (x.description||'').trim().toLowerCase()===key).length;
                const categoryChanged = draft.category && draft.category!==(e.category||'');
                const descriptionChanged = draft.description.trim() && draft.description.trim()!==(e.description||'').trim();
                return (
                  <div className="rev-row" key={e.id} style={{borderColor:'var(--green)'}}>
                    <div className="field" style={{marginBottom:8}}>
                      <input value={draft.description} onChange={ev=>setDraft({...draft,description:ev.target.value})} placeholder="Descrição" />
                    </div>
                    {descriptionChanged && siblingCount>0 && (
                      <label style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:10,padding:'8px 10px',background:'var(--bg)',border:'1px solid var(--amber)',borderRadius:6,fontSize:12.5}}>
                        <input type="checkbox" checked={draft.applyDescToAll} onChange={ev=>setDraft({...draft,applyDescToAll:ev.target.checked})} style={{marginTop:2}} />
                        <span>Tem mais {siblingCount} despesa{siblingCount>1?'s':''} igual{siblingCount>1?'is':''} a "{e.description}". Trocar a descrição de todas pra <b>"{draft.description.trim()}"</b> também?</span>
                      </label>
                    )}
                    <div className="row2" style={{marginBottom:8}}>
                      <input value={draft.amount} onChange={ev=>setDraft({...draft,amount:ev.target.value})} placeholder="Valor" inputMode="decimal" />
                      <DateField value={draft.date} onChange={d=>setDraft({...draft,date:d})} />
                    </div>
                    <div className="row2" style={{marginBottom:8}}>
                      <select value={draft.added_by} onChange={ev=>setDraft({...draft,added_by:ev.target.value})}>
                        {users.map(u=><option key={u} value={u}>{u}</option>)}
                      </select>
                      <select value={draft.category} onChange={ev=>setDraft({...draft,category:ev.target.value})}>
                        {categories.map(c=><option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {categoryChanged && siblingCount>0 && (
                      <label style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:10,padding:'8px 10px',background:'var(--bg)',border:'1px solid var(--amber)',borderRadius:6,fontSize:12.5}}>
                        <input type="checkbox" checked={draft.applyToAll} onChange={ev=>setDraft({...draft,applyToAll:ev.target.checked})} style={{marginTop:2}} />
                        <span>Tem mais {siblingCount} despesa{siblingCount>1?'s':''} igual{siblingCount>1?'is':''} a "{e.description}". Trocar a categoria de todas pra <b>{draft.category}</b> também?</span>
                      </label>
                    )}
                    <div className="field" style={{marginBottom:10}}>
                      <select value={draft.card} onChange={ev=>setDraft({...draft,card:ev.target.value})}>
                        <option value="">Sem cartão / não sei</option>
                        {draft.card && !cards.includes(draft.card) && <option value={draft.card}>{draft.card}</option>}
                        {cards.map(c=><option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <label style={{display:'flex',gap:8,alignItems:'center',marginBottom:10,fontSize:13}}>
                      <input type="checkbox" checked={draft.isRecurring} onChange={ev=>setDraft({...draft,isRecurring:ev.target.checked})} />
                      🔁 Despesa recorrente
                    </label>
                    {siblingCount>0 && (
                      <label style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:10,padding:'8px 10px',background:'var(--bg)',border:'1px solid var(--bezel)',borderRadius:6,fontSize:12.5}}>
                        <input type="checkbox" checked={draft.applyRecurringToAll} onChange={ev=>setDraft({...draft,applyRecurringToAll:ev.target.checked})} style={{marginTop:2}} />
                        <span>Marcar {siblingCount} despesa{siblingCount>1?'s':''} igual{siblingCount>1?'is':''} a "{e.description}" também como {draft.isRecurring?'recorrente':'não recorrente'}?</span>
                      </label>
                    )}
                    <div className="row2">
                      <button className="btn btn-ghost" onClick={()=>{setEditingId(null);setDraft(null);}} disabled={saving}>Cancelar</button>
                      <button className="btn btn-primary" onClick={()=>saveEdit(e.id, e.description, e.category)} disabled={saving}>{saving?'Salvando…':'Salvar'}</button>
                    </div>
                  </div>
                );
              }
              return (
                <div className="ledger-row" key={e.id} style={{gap:10}}>
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(e.id)}
                      onChange={()=>toggleSelect(e.id)}
                      style={{width:18,height:18,flexShrink:0}}
                    />
                  )}
                  <div style={{flex:1}}>
                    <div className="ledger-desc">{e.description}</div>
                    <div className="ledger-meta">
                      <span className="tag">{e.category||'Outros'}</span>
                      {e.card && <span className="tag">{e.card}</span>}
                      {e.is_recurring && <span className="tag" style={{color:'var(--amber)'}}>🔁</span>}
                      {new Date(e.date).toLocaleDateString('pt-BR')} · {e.added_by}
                    </div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div className="ledger-amt">{fmtBRL(Number(e.amount))}</div>
                    {!selectMode && confirmingDeleteId!==e.id && (
                      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
                        <span className="link" onClick={()=>startEdit(e)}>editar</span>
                        <span className="link" style={{color:'var(--red)'}} onClick={()=>setConfirmingDeleteId(e.id)}>apagar</span>
                      </div>
                    )}
                    {!selectMode && confirmingDeleteId===e.id && (
                      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
                        <span className="link" onClick={()=>setConfirmingDeleteId(null)}>cancelar</span>
                        <span className="link" style={{color:'var(--red)',fontWeight:800}} onClick={()=>del(e.id)}>confirmar?</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {filteredExpenses.length>0 && (
        <div className="month-divider" style={{borderTop:'2px solid var(--green)',borderBottom:'none',paddingTop:10,marginTop:4}}>
          <span style={{color:'var(--text)'}}>Total geral</span>
          <span style={{fontSize:15,color:'var(--green)'}}>{fmtBRL(filteredExpenses.reduce((s,e)=>s+Number(e.amount),0))}</span>
        </div>
      )}
    </div>
  );
}

// Junta lançamento manual e importação de arquivo numa aba só, já que os dois
// fazem a mesma coisa no fundo (adicionar despesa) — só muda a origem do dado.
function AddOrImportTab({client,user,categories,users,cards,reloadCards,expenses,reload,showToast,setTab}){
  const [mode,setMode] = useState('manual');
  return (
    <div>
      <div className="period-picker" style={{marginBottom:16}}>
        <button className={mode==='manual'?'active':''} onClick={()=>setMode('manual')}>✍️ Manual</button>
        <button className={mode==='file'?'active':''} onClick={()=>setMode('file')}>📥 Arquivo (PDF/CSV/foto)</button>
      </div>
      {mode==='manual' && <AddTab client={client} user={user} categories={categories} users={users} cards={cards} reloadCards={reloadCards} reload={reload} showToast={showToast} setTab={setTab} />}
      {mode==='file' && <PdfTab client={client} user={user} categories={categories} users={users} cards={cards} reloadCards={reloadCards} expenses={expenses} reload={reload} showToast={showToast} setTab={setTab} />}
    </div>
  );
}

function AddTab({client,user,categories,users,cards,reloadCards,reload,showToast,setTab}){
  const [desc,setDesc] = useState('');
  const [amount,setAmount] = useState('');
  const [category,setCategory] = useState('');
  const [card,setCard] = useState('');
  const [responsible,setResponsible] = useState(user);
  const [date,setDate] = useState(new Date().toISOString().slice(0,10));
  const [isRecurring,setIsRecurring] = useState(false);
  const [suggesting,setSuggesting] = useState(false);
  const [saving,setSaving] = useState(false);

  useEffect(()=>{ setResponsible(user); },[user]);

  async function suggestCategory(){
    if(!desc.trim()) return;
    setSuggesting(true);
    try{
      const text = await callClaude({
        max_tokens:1000,
        messages:[{role:"user",content:`Categorize esta despesa em UMA destas categorias exatas: ${categories.join(', ')}.\nDescrição: "${desc}"\nResponda APENAS com o nome exato da categoria, nada mais.`}]
      });
      const cat = text.trim();
      const match = categories.find(c=>c.toLowerCase()===cat.toLowerCase());
      setCategory(match || categories[categories.length-1] || 'Outros');
    }catch(e){ showToast('Erro ao sugerir categoria'); }
    setSuggesting(false);
  }

  async function save(){
    if(!desc.trim() || !amount){ showToast('Preencha descrição e valor'); return; }
    if(!card){ showToast('Selecione o Cartão / Fonte antes de salvar'); return; }
    setSaving(true);
    const {error} = await client.from('expenses').insert({
      description: desc.trim(), amount: parseFloat(amount.replace(',','.')),
      category: category || 'Outros', card: card.trim() || null,
      date, added_by: responsible || user, source:'manual', is_recurring: isRecurring
    });
    setSaving(false);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast('Gasto salvo ✓');
    setDesc(''); setAmount(''); setCategory(''); setCard(''); setIsRecurring(false);
    reload(); setTab('list');
  }

  return (
    <div>
      <div className="section-title">Novo gasto</div>
      <div className="card">
        <div className="field">
          <label>Descrição</label>
          <input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Ex: Supermercado Kroger" />
        </div>
        <div className="row2">
          <div className="field">
            <label>Responsável</label>
            <select value={responsible} onChange={e=>setResponsible(e.target.value)}>
              {users.map(u=><option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Valor (R$)</label>
            <input value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0,00" inputMode="decimal" />
          </div>
        </div>
        <div className="field">
          <label>Data</label>
          <DateField value={date} onChange={setDate} />
        </div>
        <div className="field">
          <label>Cartão / Fonte *</label>
          <CardPicker client={client} cards={cards} value={card} onChange={setCard} reloadCards={reloadCards} showToast={showToast} />
        </div>
        <div className="field">
          <label>Categoria</label>
          <div className="row2" style={{alignItems:'flex-end'}}>
            <select value={category} onChange={e=>setCategory(e.target.value)}>
              <option value="">Selecione…</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn btn-ghost btn-sm" style={{flex:'0 0 auto'}} onClick={suggestCategory} disabled={suggesting}>
              {suggesting ? <span className="spinner"></span> : '✨ Sugerir'}
            </button>
          </div>
        </div>
        <label style={{display:'flex',gap:8,alignItems:'center',marginBottom:14,fontSize:13.5}}>
          <input type="checkbox" checked={isRecurring} onChange={e=>setIsRecurring(e.target.checked)} />
          🔁 Despesa recorrente (repete todo mês, ex: assinatura, conta fixa)
        </label>
        <button className="btn btn-primary" onClick={save} disabled={saving || !card}>{saving?'Salvando…':'Salvar gasto'}</button>
      </div>
    </div>
  );
}

function PdfTab({client,user,categories,users,cards,reloadCards,expenses,reload,showToast,setTab}){
  const [files,setFiles] = useState([]); // [{file, status:'pending'|'skipped'|'done'|'error'}]
  const [drag,setDrag] = useState(false);
  const [extracting,setExtracting] = useState(false);
  const [progress,setProgress] = useState('');
  const [reviewing,setReviewing] = useState(null);
  const [card,setCard] = useState('');
  const [responsible,setResponsible] = useState(user);
  const inputRef = useRef();

  useEffect(()=>{ setResponsible(user); },[user]);

  function isCsv(f){ return f && (f.type==='text/csv' || /\.csv$/i.test(f.name)); }
  function isPdf(f){ return f && (f.type==='application/pdf' || /\.pdf$/i.test(f.name)); }
  function isImage(f){ return f && (f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)); }

  function handleFiles(fileList){
    const incoming = Array.from(fileList||[]);
    const valid = incoming.filter(f=>isPdf(f)||isCsv(f)||isImage(f));
    if(valid.length===0){ showToast('Envie PDF, CSV ou fotos da fatura'); return; }
    const importedLog = loadImportedFilesLog();
    const existingKeys = new Set(files.map(x=>fileLogKey(x.file)));
    const additions = valid
      .filter(f=>!existingKeys.has(fileLogKey(f))) // evita duplicar na própria seleção
      .map(f=>({ file:f, status: isFileAlreadyImported(f,importedLog) ? 'skipped' : 'pending' }));
    setFiles(prev=>[...prev, ...additions]);
  }

  function removeFile(idx){
    setFiles(prev=>prev.filter((_,i)=>i!==idx));
  }

  async function extractOne(file, categories){
    if(isCsv(file)){
      const text = await file.text();
      const items = parseCardCSV(text, categories, users);
      return items.map(it=>({...it, importSource:'csv', sourceFile:file.name}));
    }
    if(isImage(file)){
      const base64 = await new Promise((res,rej)=>{
        const r = new FileReader();
        r.onload=()=>res(r.result.split(',')[1]);
        r.onerror=rej;
        r.readAsDataURL(file);
      });
      const mimeType = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
      const imgPrompt = `Esta é uma foto de uma fatura/statement de cartão de crédito. Extraia todas as transações visíveis em JSON. Retorne APENAS um array JSON, sem texto antes ou depois, no formato:
[{"date_raw":"texto exato da data como aparece na imagem","description":"texto original curto","amount":12.34,"category":"UMA de: ${categories.join(', ')}","purchased_by_raw":"nome da pessoa responsável pela compra, se visível na imagem, senão null"}]
Regras: valores sempre positivos (gastos), ignore pagamentos/estornos de fatura, ignore linhas que não são transações, use a melhor estimativa de categoria.
Para "date_raw": copie o texto da data EXATAMENTE como aparece na imagem, sem interpretar ou converter — inclusive se for "Today", "Yesterday", "Pending", "2 hours ago", "5 minutes ago", ou nome de dia da semana como "Monday" (apps como Apple Card mostram assim pra transações recentes ou ainda não finalizadas). Não calcule a data você mesmo, apenas copie o texto.
Para "purchased_by_raw": no app da Apple Card, cada transação costuma ter uma linha embaixo tipo "Aline — 2 hours ago" ou "McKinney, TX \n Aline — Yesterday" — quando tiver um travessão "—", o nome ANTES dele é quem fez a compra, e o texto DEPOIS do travessão (o "2 hours ago", "Yesterday", etc.) vai em "date_raw". MAS o nome pode aparecer de outras formas também — negrito, sozinho numa linha, como nome completo tipo "Aline Vicente" próximo/associado à transação, ou de qualquer outro jeito visualmente destacado ligado àquela transação específica. Capture o nome sempre que ele estiver visível e associado à transação, mesmo sem o formato "Nome — tempo". Só use null se não tiver NENHUM nome de pessoa visível pra aquela transação (só a data/hora sozinha, o que geralmente indica que foi o titular principal do cartão).

ATENÇÃO ao layout: muitos apps de banco/cartão (Capital One, Apple Card, etc.) mostram a data como um CABEÇALHO separado acima de um grupo de transações (ex: "July 3" no topo, seguido de várias transações sem data individual embaixo). Nesse caso, TODAS as transações listadas abaixo de um cabeçalho de data pertencem àquela mesma data, até aparecer o próximo cabeçalho de data. Use o texto desse cabeçalho como "date_raw" pra cada uma dessas transações — não deixe nenhuma sem data e não invente datas diferentes dentro do mesmo grupo.`;
      const text = await callClaude({
        json: true,
        max_tokens:4000,
        messages:[{role:"user",content:[
          {type:"document",source:{type:"base64",media_type:mimeType,data:base64}},
          {type:"text",text:imgPrompt}
        ]}]
      });
      const items = extractJson(text);
      return items.map(it=>({...it, date: normalizeDate(it.date_raw||it.date), added_by: matchUserFromText(it.purchased_by_raw, users), importSource:'image', sourceFile:file.name}));
    }
    const pdfText = await extractPdfText(file);
    const prompt = `Aqui está o texto extraído de uma fatura/statement de cartão de crédito. Extraia todas as transações em JSON. Retorne APENAS um array JSON, sem texto antes ou depois, no formato:
[{"date":"YYYY-MM-DD","description":"texto original curto","amount":12.34,"category":"UMA de: ${categories.join(', ')}","purchased_by_raw":"nome da pessoa responsável pela compra, se identificável no texto (ex: cabeçalho de seção por cartão adicional), senão null"}]
Regras: valores sempre positivos (gastos), ignore pagamentos/estornos de fatura (linhas de "PYMT", "PAYMENT", "CREDIT"), ignore linhas que não são transações, use a melhor estimativa de categoria, o ano das datas é o mesmo do período da fatura.
Statements com cartão adicional (Capital One, etc.) costumam separar as transações em seções com o nome do titular no cabeçalho (ex: "VINICIUS VICENTE #8653: Transactions"). Se identificar isso, use esse nome como "purchased_by_raw" pra cada transação daquela seção.

TEXTO DA FATURA:
${pdfText.slice(0, 30000)}`;
    const text = await callClaude({
      json: true,
      max_tokens:4000,
      messages:[{role:"user",content:prompt}]
    });
    const items = extractJson(text);
    return items.map(it=>({...it, added_by: matchUserFromText(it.purchased_by_raw, users), importSource:'pdf', sourceFile:file.name}));
  }

  async function extractAll(){
    if(!card){ showToast('Selecione o Cartão / Fonte antes de importar'); return; }
    const pending = files.filter(f=>f.status==='pending');
    if(pending.length===0){ showToast('Nenhum arquivo novo pra processar'); return; }
    setExtracting(true);
    const allItems = [];
    const succeededFiles = [];
    const nextFiles = [...files];
    for(let i=0;i<pending.length;i++){
      const entry = pending[i];
      const idx = nextFiles.indexOf(entry);
      setProgress(`Processando arquivo ${i+1} de ${pending.length}: ${entry.file.name}`);
      try{
        const items = await extractOne(entry.file, categories);
        allItems.push(...items.map(it=>({...it, include:true})));
        nextFiles[idx] = {...entry, status:'done'};
        succeededFiles.push(entry.file);
      }catch(e){
        nextFiles[idx] = {...entry, status:'error'};
        showToast(entry.file.name+': '+friendlyErrorMessage(e.message));
      }
    }
    setFiles(nextFiles);
    setProgress('');
    setExtracting(false);
    if(succeededFiles.length>0) markFilesImported(succeededFiles);
    if(allItems.length===0){ showToast('Nenhuma transação encontrada'); return; }
    setReviewing(markPossibleDuplicates(markDuplicates(allItems, expenses), expenses, card));
  }

  async function confirmSave(){
    if(!card){ showToast('Selecione o Cartão / Fonte antes de importar'); return; }
    const existingSigs = new Set((expenses||[]).map(e=>expenseSignature(e.date,e.description,e.amount)));
    const checked = reviewing.filter(r=>r.include);
    const toSave = checked
      .filter(r=>!existingSigs.has(expenseSignature(r.date,r.description,r.amount)))
      .map(r=>({
        description:r.description, amount:Number(r.amount), category:r.category||'Outros',
        card: card.trim() || null, date:r.date, added_by: r.added_by || responsible || user, source: r.importSource || 'pdf'
      }));
    const skipped = checked.length - toSave.length;
    if(toSave.length===0){ showToast(skipped>0 ? 'Tudo selecionado já existia, nada novo importado' : 'Nada selecionado'); return; }
    const {error} = await client.from('expenses').insert(toSave);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast(toSave.length+' importados'+(skipped>0?` (${skipped} duplicata(s) ignorada(s))`:'')+' ✓');
    setReviewing(null); setFiles([]);
    reload(); setTab('list');
  }

  if(reviewing){
    return (
      <div>
        <div className="section-title">Revisar {reviewing.length} lançamentos</div>
        <div className="card">
          <div className="row2">
            <div className="field">
              <label>Responsável</label>
              <select value={responsible} onChange={e=>setResponsible(e.target.value)}>
                {users.map(u=><option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Cartão / Fonte *</label>
              <CardPicker client={client} cards={cards} value={card} onChange={setCard} reloadCards={reloadCards} showToast={showToast} />
            </div>
          </div>
        </div>
        <p className="muted" style={{marginBottom:12}}>
          Desmarque o que não quiser importar e ajuste a categoria se precisar.
          {reviewing.some(r=>r.duplicate) && <> <span style={{color:'var(--amber)'}}>{reviewing.filter(r=>r.duplicate).length} possível(is) duplicata(s) exata(s)</span> já desmarcada(s) automaticamente (mesma data, descrição e valor de um lançamento já salvo).</>}
          {reviewing.some(r=>r.possibleDuplicate) && <> <span style={{color:'var(--red)'}}>{reviewing.filter(r=>r.possibleDuplicate).length} parecida(s) com algo já salvo</span> (mesma data, valor e cartão, mas descrição diferente) — confere se não é a mesma despesa antes de marcar.</>}
        </p>
        {reviewing.map((r,i)=>(
          <div className="rev-row" key={i} style={r.duplicate?{borderColor:'var(--amber)'}:(r.possibleDuplicate?{borderColor:'var(--red)'}:undefined)}>
            <div className="r1">
              <label style={{display:'flex',gap:8,alignItems:'center'}}>
                <input type="checkbox" checked={r.include} onChange={e=>{
                  const cp=[...reviewing]; cp[i]={...cp[i],include:e.target.checked}; setReviewing(cp);
                }} />
                {r.description}
                {r.duplicate && <span className="tag" style={{color:'var(--amber)',borderColor:'var(--amber)'}}>duplicata</span>}
                {r.possibleDuplicate && <span className="tag" style={{color:'var(--red)',borderColor:'var(--red)'}}>parecida?</span>}
              </label>
              <span style={{fontFamily:'JetBrains Mono, monospace'}}>{fmtBRL(Number(r.amount))}</span>
            </div>
            {r.possibleDuplicate && (
              <p className="muted" style={{marginTop:4,marginBottom:0,fontSize:11.5}}>
                Já existe <b>"{r.matchedDescription}"</b> nessa mesma data, valor e cartão. É a mesma despesa? Se for, deixa desmarcada. Se for diferente mesmo, marca a caixinha pra importar.
              </p>
            )}
            <div className="muted" style={{marginTop:4}}>
              {new Date(r.date).toLocaleDateString('pt-BR')}{r.sourceFile ? ' · '+r.sourceFile : ''}
              {r.added_by && users.length>1 && <> · <span style={{color:'var(--green)'}}>{r.added_by}</span></>}
            </div>
            {users.length>1 && (
              <select value={r.added_by||''} onChange={e=>{
                const cp=[...reviewing]; cp[i]={...cp[i],added_by:e.target.value||undefined}; setReviewing(cp);
              }} style={{marginTop:6}}>
                <option value="">Responsável do lote ({responsible})</option>
                {users.map(u=><option key={u} value={u}>{u}</option>)}
              </select>
            )}
            <select value={r.category} onChange={e=>{
              const cp=[...reviewing]; cp[i]={...cp[i],category:e.target.value}; setReviewing(cp);
            }} style={{marginTop:6}}>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ))}
        <button className="btn btn-primary" onClick={confirmSave} style={{marginTop:8}} disabled={!card}>Importar selecionados</button>
        <button className="btn btn-ghost" style={{marginTop:8}} onClick={()=>setReviewing(null)}>Cancelar</button>
      </div>
    );
  }

  const pendingCount = files.filter(f=>f.status==='pending').length;
  const skippedCount = files.filter(f=>f.status==='skipped').length;

  return (
    <div>
      <div className="section-title">Importar fatura (PDF, CSV ou foto)</div>
      <div className="card">
        <div className="row2">
          <div className="field">
            <label>Responsável</label>
            <select value={responsible} onChange={e=>setResponsible(e.target.value)}>
              {users.map(u=><option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Cartão / Fonte *</label>
            <CardPicker client={client} cards={cards} value={card} onChange={setCard} reloadCards={reloadCards} showToast={showToast} />
          </div>
        </div>
      </div>
      <div
        className={"dropzone"+(drag?' drag':'')}
        onClick={()=>inputRef.current.click()}
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);handleFiles(e.dataTransfer.files);}}
      >
        <input ref={inputRef} type="file" multiple accept="application/pdf,.pdf,text/csv,.csv,image/*" onChange={e=>{handleFiles(e.target.files); e.target.value='';}} />
        {files.length>0 ? <div><b>{files.length} arquivo(s) selecionado(s)</b></div> : <div>📄 Toque ou arraste um ou vários arquivos (PDF, CSV ou fotos)</div>}
      </div>
      {files.length>0 && (
        <div className="card" style={{marginTop:10}}>
          {files.map((f,i)=>(
            <div className="ledger-row" key={i} style={{padding:'8px 2px'}}>
              <div>
                <div className="ledger-desc" style={{fontSize:13}}>{f.file.name}</div>
                <div className="ledger-meta">
                  {f.status==='pending' && 'pronto pra importar'}
                  {f.status==='skipped' && <span style={{color:'var(--amber)'}}>já importado antes — será pulado</span>}
                  {f.status==='done' && <span style={{color:'var(--green)'}}>processado ✓</span>}
                  {f.status==='error' && <span style={{color:'var(--red)'}}>erro ao processar</span>}
                </div>
              </div>
              <div style={{display:'flex',gap:12}}>
                {f.status==='error' && <span className="link" onClick={()=>{
                  setFiles(prev=>prev.map((x,idx)=>idx===i?{...x,status:'pending'}:x));
                }}>tentar de novo</span>}
                <span className="link" onClick={()=>removeFile(i)}>remover</span>
              </div>
            </div>
          ))}
          {skippedCount>0 && <p className="muted" style={{marginTop:8}}>{skippedCount} arquivo(s) já foi(ram) importado(s) antes e será(ão) pulado(s) automaticamente.</p>}
        </div>
      )}
      <p className="muted" style={{marginTop:10}}>PDF ou foto (extração via IA), ou CSV (ex: Apple Card, que não gera PDF de fatura). * Cartão/Fonte é obrigatório. Pode selecionar vários arquivos de uma vez.</p>
      {extracting && progress && <p className="muted">{progress}</p>}
      <button className="btn btn-gold" style={{marginTop:14}} onClick={extractAll} disabled={extracting || !card || pendingCount===0}>
        {extracting ? <span className="spinner"></span> : `Extrair transações (${pendingCount} novo${pendingCount===1?'':'s'})`}
      </button>
    </div>
  );
}

// Aba "A Pagar" — organiza por mês, puxa os cartões de crédito cadastrados
// automaticamente (com saldo do Plaid/manual quando tiver) e permite adicionar
// contas avulsas (mortgage, AT&T, etc.). Quando "Valor pago" é preenchido, cria
// ou atualiza um lançamento com categoria "Pagamento Efetuado" (crédito).
function PayablesTab({client,cards,users,expenses,reload,showToast}){
  const [monthKey,setMonthKey] = useState(new Date().toISOString().slice(0,7));
  const [rows,setRows] = useState([]);
  const [balances,setBalances] = useState([]);
  const [loading,setLoading] = useState(true);
  const [savingId,setSavingId] = useState(null);
  const [addingBill,setAddingBill] = useState(false);
  const [newBill,setNewBill] = useState({description:'',open_amount:'',minimum_payment:'',paid_amount:''});
  const requestIdRef = useRef(0);
  const [checkingNew,setCheckingNew] = useState(false);
  const [pendingNewCards,setPendingNewCards] = useState([]);

  const monthLabel = capitalize(new Date(monthKey+'-02').toLocaleDateString('pt-BR',{month:'long',year:'numeric'}));

  async function loadBalances(){
    try{
      const res = await fetch('/api/plaid-status');
      const data = await res.json();
      if(res.ok){ setBalances(data.connections||[]); return data.connections||[]; }
    }catch(e){ /* ignora */ }
    return [];
  }

  function suggestedOpenFor(cardId, balList){
    const list = balList || balances;
    const b = list.find(x=>x.card_id===cardId);
    const card = (cards||[]).find(c=>c.id===cardId);
    if(b?.status==='connected' && b.current_balance!=null) return b.current_balance;
    if(card?.manual_balance!=null) return card.manual_balance;
    return null;
  }

  async function loadRows(balancesData, requestId){
    setLoading(true);
    const balList = balancesData || balances;
    const {data,error} = await client.from('bills_to_pay').select('*').eq('month_key',monthKey).order('created_at',{ascending:true});
    if(error){ setLoading(false); showToast('Erro: '+error.message); return; }
    if(requestId!=null && requestIdRef.current!==requestId){ setLoading(false); return; } // superada por uma carga mais nova, não mexe em nada

    let allRows = data||[];

    // Preenche automaticamente linhas que já estão na lista mas ficaram sem valor em
    // aberto (ex: card criado antes do saldo do Plaid terminar de carregar). Isso só
    // corrige dado de linha que já existe — não adiciona cartão novo nenhum sozinho.
    const toBackfill = allRows.filter(r=>r.card_id && r.open_amount==null && suggestedOpenFor(r.card_id,balList)!=null);
    if(toBackfill.length>0){
      await Promise.all(toBackfill.map(r=>
        client.from('bills_to_pay').update({ open_amount: suggestedOpenFor(r.card_id,balList) }).eq('id',r.id)
      ));
      allRows = allRows.map(r=>{
        const bf = toBackfill.find(x=>x.id===r.id);
        return bf ? {...r, open_amount: suggestedOpenFor(r.card_id,balList)} : r;
      });
    }

    setRows(allRows.sort((a,b)=> (a.card_id?0:1) - (b.card_id?0:1) || new Date(a.created_at)-new Date(b.created_at)));
    setLoading(false);
  }

  // "Atualizar lista": procura cartões de crédito cadastrados que ainda não estão
  // nessa lista do mês, e pergunta antes de adicionar (nunca adiciona sozinho).
  async function checkForNewCards(){
    setCheckingNew(true);
    const bals = await loadBalances();
    const {data} = await client.from('bills_to_pay').select('card_id').eq('month_key',monthKey);
    const existingIds = new Set((data||[]).filter(r=>r.card_id).map(r=>r.card_id));
    const creditCards = (cards||[]).filter(c=>(c.account_type||'credit')==='credit');
    const missing = creditCards.filter(c=>!existingIds.has(c.id));
    setCheckingNew(false);
    if(missing.length===0){ showToast('Nenhum cartão novo — lista já está completa'); return; }
    setPendingNewCards(missing.map(c=>({ id:c.id, name:c.name, suggestedOpen: suggestedOpenFor(c.id,bals), checked:true })));
  }

  async function confirmAddNewCards(){
    const toAdd = pendingNewCards.filter(c=>c.checked);
    if(toAdd.length===0){ setPendingNewCards([]); return; }
    const toInsert = toAdd.map(c=>({ month_key: monthKey, card_id: c.id, description: c.name, open_amount: c.suggestedOpen }));
    const {error} = await client.from('bills_to_pay').insert(toInsert);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast(toAdd.length+' cartão(ões) adicionado(s) ✓');
    setPendingNewCards([]);
    loadRows(balances);
  }

  useEffect(()=>{
    async function init(){
      if(!client || !cards) return;
      const myId = ++requestIdRef.current;
      const bals = await loadBalances();
      if(requestIdRef.current !== myId) return; // uma carga mais nova já começou, descarta essa
      await loadRows(bals, myId);
    }
    init();
  },[monthKey, client, cards]);

  function changeMonth(delta){
    const d = new Date(monthKey+'-02');
    d.setMonth(d.getMonth()+delta);
    setMonthKey(d.toISOString().slice(0,7));
  }

  function updateLocal(id, field, value){
    setRows(prev=>prev.map(r=>r.id===id ? {...r,[field]:value} : r));
  }

  // Cria/atualiza/apaga o lançamento "Pagamento Efetuado" ligado a essa linha,
  // conforme o valor pago mudou.
  // Não cria lançamento nenhum — o pagamento em si vai entrar sozinho via Plaid
  // quando sincronizar (é uma transação real no extrato). Aqui só procura um
  // lançamento já existente que bate (mesmo valor, data próxima, mesmo cartão/fonte
  // se for o caso) e liga os dois, pra sinalizar que deu match.
  function findMatchingExpense(row){
    const paid = row.paid_amount ? parseFloat(String(row.paid_amount).replace(',','.')) : 0;
    if(paid<=0) return null;
    const paidDate = row.paid_date || new Date().toISOString().slice(0,10);
    const paidTime = new Date(paidDate).getTime();
    const cardName = row.card_id ? row.description : null;

    const candidates = (expenses||[]).filter(e=>{
      const sameAmount = Math.abs(Number(e.amount)-paid) < 0.01;
      if(!sameAmount) return false;
      const diffDays = Math.abs(new Date(e.date).getTime()-paidTime) / 86400000;
      if(diffDays > 7) return false;
      if(cardName) return (e.card||'').trim().toLowerCase()===cardName.trim().toLowerCase();
      // conta avulsa: sem cartão pra comparar, aceita por valor+data só
      return true;
    });
    return candidates[0] || null;
  }

  async function saveRow(row){
    setSavingId(row.id);
    const match = findMatchingExpense(row);
    const {error} = await client.from('bills_to_pay').update({
      description: row.description,
      open_amount: row.open_amount===''?null:parseFloat(String(row.open_amount).replace(',','.')),
      minimum_payment: row.minimum_payment===''?null:parseFloat(String(row.minimum_payment).replace(',','.')),
      paid_amount: row.paid_amount===''?null:parseFloat(String(row.paid_amount).replace(',','.')),
      paid_date: row.paid_amount ? (row.paid_date || new Date().toISOString().slice(0,10)) : null,
      expense_id: match ? match.id : null
    }).eq('id',row.id);
    setSavingId(null);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast(match ? 'Salvo — encontrado no lançamento ✓' : 'Salvo (ainda sem lançamento correspondente)');
    loadRows();
  }

  // Botão pra tentar de novo depois de sincronizar o Plaid, sem precisar reeditar o campo
  async function recheckMatch(row){
    setSavingId(row.id);
    const match = findMatchingExpense(row);
    await client.from('bills_to_pay').update({ expense_id: match ? match.id : null }).eq('id',row.id);
    setSavingId(null);
    showToast(match ? 'Encontrado no lançamento ✓' : 'Ainda não achou — sincroniza o Plaid e tenta de novo');
    loadRows();
  }


  async function deleteBill(row){
    await client.from('bills_to_pay').delete().eq('id',row.id);
    showToast('Removida');
    loadRows();
  }

  async function addStandaloneBill(){
    if(!newBill.description.trim()){ showToast('Preencha a descrição'); return; }
    const paidDate = newBill.paid_amount ? new Date().toISOString().slice(0,10) : null;
    const match = newBill.paid_amount ? findMatchingExpense({
      paid_amount: newBill.paid_amount, paid_date: paidDate, card_id: null, description: newBill.description.trim()
    }) : null;
    const {error} = await client.from('bills_to_pay').insert({
      month_key: monthKey,
      description: newBill.description.trim(),
      open_amount: newBill.open_amount ? parseFloat(newBill.open_amount.replace(',','.')) : null,
      minimum_payment: newBill.minimum_payment ? parseFloat(newBill.minimum_payment.replace(',','.')) : null,
      paid_amount: newBill.paid_amount ? parseFloat(newBill.paid_amount.replace(',','.')) : null,
      paid_date: paidDate,
      expense_id: match ? match.id : null
    });
    if(error){ showToast('Erro: '+error.message); return; }
    setNewBill({description:'',open_amount:'',minimum_payment:'',paid_amount:''});
    setAddingBill(false);
    loadRows();
  }

  const totals = rows.reduce((acc,r)=>{
    const open = Number(r.open_amount)||0;
    const paid = Number(r.paid_amount)||0;
    const min = Number(r.minimum_payment)||0;
    acc.open += open; acc.paid += paid; acc.saldo += (open-paid); acc.minimum += min;
    return acc;
  }, {open:0,paid:0,saldo:0,minimum:0});

  // Total disponível nas contas bancárias (mesmo dado do card "Contas Bancárias" no Resumo),
  // pra ver se dá pra cobrir os mínimos desse mês.
  const bankAccountsTotal = (cards||[])
    .filter(c=>c.account_type==='bank')
    .reduce((sum,c)=>{
      const b = balances.find(x=>x.card_id===c.id);
      const connected = b?.status==='connected';
      const value = connected ? (b.available_balance ?? b.current_balance ?? 0) : (c.manual_balance ?? 0);
      return sum + Number(value||0);
    }, 0);
  const monthBalance = bankAccountsTotal - totals.minimum;

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
        <button className="btn btn-ghost btn-sm" onClick={()=>changeMonth(-1)}>◀</button>
        <div style={{fontWeight:800,fontSize:15}}>{monthLabel}</div>
        <button className="btn btn-ghost btn-sm" onClick={()=>changeMonth(1)}>▶</button>
      </div>

      <button className="btn btn-ghost" style={{marginBottom:16}} onClick={checkForNewCards} disabled={checkingNew}>
        {checkingNew ? <span className="spinner"></span> : '🔄 Atualizar lista'}
      </button>

      {pendingNewCards.length>0 && (
        <div className="card" style={{borderColor:'var(--green)'}}>
          <div style={{fontWeight:700,marginBottom:6}}>{pendingNewCards.length} cartão(ões) novo(s) encontrado(s)</div>
          <p className="muted" style={{marginBottom:10}}>Não estão nessa lista ainda. Marca os que quiser adicionar em {monthLabel}.</p>
          {pendingNewCards.map((c,i)=>(
            <label key={c.id} style={{display:'flex',gap:8,alignItems:'center',marginBottom:8}}>
              <input type="checkbox" checked={c.checked} onChange={e=>{
                const cp=[...pendingNewCards]; cp[i]={...cp[i],checked:e.target.checked}; setPendingNewCards(cp);
              }} />
              {c.name}{c.suggestedOpen!=null && <span className="muted" style={{marginLeft:6}}>({fmtBRL(c.suggestedOpen)})</span>}
            </label>
          ))}
          <div className="row2">
            <button className="btn btn-ghost" onClick={()=>setPendingNewCards([])}>Ignorar</button>
            <button className="btn btn-primary" onClick={confirmAddNewCards}>Adicionar selecionados</button>
          </div>
        </div>
      )}

      {loading && <div className="empty">Carregando…</div>}

      {!loading && rows.map(row=>{
        const isConnected = row.card_id && balances.some(b=>b.card_id===row.card_id && b.status==='connected');
        return (
        <div key={row.id} className="card" style={{marginBottom:10,position:'relative'}}>
          {isConnected && (
            <span style={{position:'absolute',top:10,right:10,fontSize:9.5,fontWeight:800,letterSpacing:'0.03em',padding:'2px 8px',borderRadius:20,background:'var(--green)',color:'#fff'}}>PLAID</span>
          )}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8,paddingRight:isConnected?54:0}}>
            {row.card_id ? (
              <div className="ledger-desc">{row.description}</div>
            ) : (
              <input value={row.description} onChange={e=>updateLocal(row.id,'description',e.target.value)} onBlur={()=>saveRow(row)} style={{flex:1,marginRight:8}} />
            )}
            <span className="link" style={{color:'var(--red)'}} onClick={()=>deleteBill(row)}>{row.card_id ? 'remover' : 'excluir'}</span>
          </div>
          <div className="row2" style={{marginBottom:8}}>
            <div className="field" style={{marginBottom:0}}>
              <label>Valor em aberto</label>
              <input value={row.open_amount??''} onChange={e=>updateLocal(row.id,'open_amount',e.target.value)} onBlur={()=>saveRow(row)} placeholder="0,00" inputMode="decimal" />
            </div>
            <div className="field" style={{marginBottom:0}}>
              <label>Mínimo</label>
              <input value={row.minimum_payment??''} onChange={e=>updateLocal(row.id,'minimum_payment',e.target.value)} onBlur={()=>saveRow(row)} placeholder="0,00" inputMode="decimal" />
            </div>
          </div>
          <div className="row2">
            <div className="field" style={{marginBottom:0}}>
              <label>Valor pago</label>
              <input value={row.paid_amount??''} onChange={e=>updateLocal(row.id,'paid_amount',e.target.value)} onBlur={()=>saveRow(row)} placeholder="0,00" inputMode="decimal" />
            </div>
            <div className="field" style={{marginBottom:0}}>
              <label>Saldo</label>
              <div className="field-display" style={{color: ((Number(row.open_amount)||0)-(Number(row.paid_amount)||0))>0 ? 'var(--amber)' : 'var(--green)'}}>
                {fmtBRL((Number(row.open_amount)||0)-(Number(row.paid_amount)||0))}
              </div>
            </div>
          </div>
          {savingId===row.id && <p className="muted" style={{marginTop:6,fontSize:11}}>Salvando…</p>}
          {savingId!==row.id && row.paid_amount>0 && (
            row.expense_id ? (
              <p style={{marginTop:8,fontSize:11.5,color:'var(--green)'}}>✅ Encontrado no lançamento</p>
            ) : (
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:8}}>
                <span style={{fontSize:11.5,color:'var(--amber)'}}>⏳ Aguardando lançamento correspondente</span>
                <span className="link" onClick={()=>recheckMatch(row)}>tentar de novo</span>
              </div>
            )
          )}
        </div>
        );
      })}

      {!loading && (
        <div className="card" style={{background:'var(--panel-2)'}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
            <span className="muted">Total em aberto</span><b style={{fontFamily:'JetBrains Mono, monospace'}}>{fmtBRL(totals.open)}</b>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
            <span className="muted">Total mínimo</span><b style={{fontFamily:'JetBrains Mono, monospace'}}>{fmtBRL(totals.minimum)}</b>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
            <span className="muted">Total pago</span><b style={{fontFamily:'JetBrains Mono, monospace',color:'var(--green)'}}>{fmtBRL(totals.paid)}</b>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:12}}>
            <span className="muted">Saldo total</span><b style={{fontFamily:'JetBrains Mono, monospace',color:totals.saldo>0?'var(--amber)':'var(--green)'}}>{fmtBRL(totals.saldo)}</b>
          </div>
        </div>
      )}

      {!loading && (
        <div className="card" style={{borderColor:'var(--green)'}}>
          <div style={{fontWeight:700,marginBottom:8,fontSize:13}}>Saldo do mês</div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
            <span className="muted">Total em contas (Resumo)</span><b style={{fontFamily:'JetBrains Mono, monospace'}}>{fmtBRL(bankAccountsTotal)}</b>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:8}}>
            <span className="muted">− Total mínimo</span><b style={{fontFamily:'JetBrains Mono, monospace'}}>{fmtBRL(totals.minimum)}</b>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:13,paddingTop:8,borderTop:'1px dashed var(--bezel)'}}>
            <span style={{fontWeight:700}}>Saldo do mês</span>
            <b style={{fontFamily:'JetBrains Mono, monospace',color:monthBalance>=0?'var(--green)':'var(--red)'}}>{fmtBRL(monthBalance)}</b>
          </div>
        </div>
      )}

      {!addingBill && (
        <button className="btn btn-ghost" style={{marginTop:6}} onClick={()=>setAddingBill(true)}>+ Adicionar conta avulsa (mortgage, AT&T, etc.)</button>
      )}
      {addingBill && (
        <div className="card">
          <div className="field">
            <label>Descrição</label>
            <input value={newBill.description} onChange={e=>setNewBill({...newBill,description:e.target.value})} placeholder="Ex: Mortgage, AT&T Wireless" />
          </div>
          <div className="row2" style={{marginBottom:8}}>
            <div className="field" style={{marginBottom:0}}>
              <label>Valor em aberto</label>
              <input value={newBill.open_amount} onChange={e=>setNewBill({...newBill,open_amount:e.target.value})} placeholder="0,00" inputMode="decimal" />
            </div>
            <div className="field" style={{marginBottom:0}}>
              <label>Mínimo</label>
              <input value={newBill.minimum_payment} onChange={e=>setNewBill({...newBill,minimum_payment:e.target.value})} placeholder="0,00" inputMode="decimal" />
            </div>
          </div>
          <div className="field">
            <label>Valor pago</label>
            <input value={newBill.paid_amount} onChange={e=>setNewBill({...newBill,paid_amount:e.target.value})} placeholder="0,00" inputMode="decimal" />
          </div>
          <div className="row2">
            <button className="btn btn-ghost" onClick={()=>{setAddingBill(false);setNewBill({description:'',open_amount:'',minimum_payment:'',paid_amount:''});}}>Cancelar</button>
            <button className="btn btn-primary" onClick={addStandaloneBill}>Adicionar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigScreen({cfg,onSave,embedded,categories,users,cards,client,reloadCategories,reloadUsers,reloadCards,reloadExpenses,showToast}){
  const [url,setUrl] = useState(cfg.url||'');
  const [key,setKey] = useState(cfg.key||'');
  const [msg,setMsg] = useState('');
  const [newCat,setNewCat] = useState('');
  const [newCatIsCredit,setNewCatIsCredit] = useState(false);
  const [editingId,setEditingId] = useState(null);
  const [editingName,setEditingName] = useState('');
  const [newUser,setNewUser] = useState('');
  const [editingUserId,setEditingUserId] = useState(null);
  const [editingUserName,setEditingUserName] = useState('');
  const [newCard,setNewCard] = useState('');
  const [newCardType,setNewCardType] = useState('credit');
  const [editingCardId,setEditingCardId] = useState(null);
  const [editingCardName,setEditingCardName] = useState('');
  const [busy,setBusy] = useState(false);
  const [plaidConns,setPlaidConns] = useState({}); // card_id -> {status, account_name, last_synced_at}
  const [plaidPending,setPlaidPending] = useState([]); // contas ainda não associadas a nenhum cartão
  const [connectingCardId,setConnectingCardId] = useState(null);
  const [syncingCardId,setSyncingCardId] = useState(null);
  const [disconnectingId,setDisconnectingId] = useState(null);
  const [assignDrafts,setAssignDrafts] = useState({}); // connection_id -> {mode:'existing'|'new', cardId, newName}
  const [assigning,setAssigning] = useState(false);

  async function loadPlaidStatus(){
    try{
      const res = await fetch('/api/plaid-status');
      const data = await res.json();
      if(!res.ok) return; // sem configuração do Plaid ainda, tudo bem, só não mostra status
      const map = {};
      (data.connections||[]).forEach(c=>{ map[c.card_id] = c; });
      setPlaidConns(map);
      setPlaidPending(data.pending||[]);
    }catch(e){ /* Plaid ainda não configurado, ignora */ }
  }

  useEffect(()=>{ if(embedded) loadPlaidStatus(); },[embedded]);

  async function connectCard(cardId, cardName){
    if(!window.Plaid){ showToast('SDK do Plaid não carregou, tenta recarregar a página'); return; }
    setConnectingCardId(cardId);
    try{
      const tokenRes = await fetch('/api/plaid-link-token', { method:'POST' });
      const tokenData = await tokenRes.json();
      if(!tokenRes.ok){ showToast('Erro: '+(tokenData.error||'não consegui iniciar a conexão')); setConnectingCardId(null); return; }

      // Guarda o estado ANTES de abrir, porque se o banco usar login OAuth,
      // a página recarrega do zero quando volta — precisamos retomar de onde parou.
      sessionStorage.setItem('plaid_pending', JSON.stringify({ linkToken: tokenData.link_token, cardId, cardName }));

      openPlaidLink(tokenData.link_token, cardId, cardName);
    }catch(e){
      setConnectingCardId(null);
      showToast('Erro ao conectar: '+e.message);
    }
  }

  function openPlaidLink(linkToken, cardId, cardName, receivedRedirectUri){
    const handler = window.Plaid.create({
      token: linkToken,
      receivedRedirectUri: receivedRedirectUri,
      onSuccess: async (public_token, metadata) => {
        sessionStorage.removeItem('plaid_pending');
        const exRes = await fetch('/api/plaid-exchange', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ public_token, institution_name: metadata?.institution?.name })
        });
        const exData = await exRes.json();
        setConnectingCardId(null);
        if(!exRes.ok){ showToast('Erro ao conectar: '+(exData.error||'')); return; }

        const conns = exData.connections||[];
        if(conns.length===1){
          // Só uma conta veio — associa direto com o cartão que o usuário clicou
          const asRes = await fetch('/api/plaid-assign', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ connection_id: conns[0].id, card_id: cardId })
          });
          if(asRes.ok){ showToast('"'+cardName+'" conectado ✓'); }
          else { const d = await asRes.json(); showToast('Erro ao associar: '+(d.error||'')); }
          loadPlaidStatus();
          reloadCards();
          return;
        }

        // Vieram várias contas — mostra escolha, pré-selecionando o cartão clicado na primeira
        const drafts = {};
        conns.forEach((c,i)=>{
          drafts[c.id] = i===0
            ? { mode:'existing', cardId: cardId, newName:'' }
            : { mode:'new', cardId:'', newName:'' };
        });
        setAssignDrafts(prev=>({...prev, ...drafts}));
        showToast(conns.length+' contas encontradas — escolhe qual cartão é cada uma');
        loadPlaidStatus();
      },
      onExit: () => { sessionStorage.removeItem('plaid_pending'); setConnectingCardId(null); },
    });
    handler.open();
  }

  async function confirmAssignments(){
    setAssigning(true);
    let okCount = 0, errCount = 0;
    for(const conn of plaidPending){
      const draft = assignDrafts[conn.id];
      if(!draft) continue;
      const body = draft.mode==='new'
        ? { connection_id: conn.id, new_card_name: draft.newName }
        : { connection_id: conn.id, card_id: draft.cardId };
      if(draft.mode==='new' && !draft.newName.trim()) continue;
      if(draft.mode==='existing' && !draft.cardId) continue;
      const res = await fetch('/api/plaid-assign', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if(res.ok) okCount++; else errCount++;
    }
    setAssigning(false);
    showToast(okCount+' conta(s) associada(s)'+(errCount>0?', '+errCount+' com erro':'')+' ✓');
    setAssignDrafts({});
    loadPlaidStatus();
    reloadCards();
  }

  // Se a página recarregou de volta de um login OAuth de banco, retoma a conexão sozinho.
  useEffect(()=>{
    if(!embedded || !window.Plaid) return;
    if(!window.location.search.includes('oauth_state_id')) return;
    const pending = sessionStorage.getItem('plaid_pending');
    if(!pending) return;
    const { linkToken, cardId, cardName } = JSON.parse(pending);
    setConnectingCardId(cardId);
    openPlaidLink(linkToken, cardId, cardName, window.location.href);
    window.history.replaceState({}, '', window.location.pathname);
  },[embedded]);

  async function syncCard(cardId, cardName){
    setSyncingCardId(cardId);
    try{
      const res = await fetch('/api/plaid-sync', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ card_id: cardId })
      });
      const data = await res.json();
      setSyncingCardId(null);
      if(!res.ok){ showToast('Erro ao sincronizar: '+(data.error||'')); return; }
      const pendingMsg = data.pending>0 ? `, ${data.pending} pendente(s) de revisão` : '';
      showToast('"'+cardName+'": '+data.imported+' nova(s) despesa(s) importada(s)'+pendingMsg+' ✓');
      loadPlaidStatus();
      if(reloadExpenses) reloadExpenses();
    }catch(e){
      setSyncingCardId(null);
      showToast('Erro ao sincronizar: '+e.message);
    }
  }

  async function disconnectCard(cardId, cardName){
    setSyncingCardId(cardId);
    try{
      const res = await fetch('/api/plaid-disconnect', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ card_id: cardId })
      });
      const data = await res.json();
      setSyncingCardId(null);
      setDisconnectingId(null);
      if(!res.ok){ showToast('Erro ao desconectar: '+(data.error||'')); return; }
      showToast('"'+cardName+'" desconectado');
      loadPlaidStatus();
    }catch(e){
      setSyncingCardId(null);
      setDisconnectingId(null);
      showToast('Erro ao desconectar: '+e.message);
    }
  }

  async function addCategory(){
    const name = newCat.trim();
    if(!name) return;
    if((categories||[]).some(c=>c.name.toLowerCase()===name.toLowerCase())){
      showToast('Essa categoria já existe'); return;
    }
    setBusy(true);
    const {error} = await client.from('categories').insert({name, is_credit:newCatIsCredit});
    setBusy(false);
    if(error){ showToast('Erro: '+error.message); return; }
    setNewCat(''); setNewCatIsCredit(false);
    reloadCategories();
  }

  async function toggleCategoryCredit(id, value){
    const {error} = await client.from('categories').update({ is_credit: value }).eq('id',id);
    if(error){ showToast('Erro: '+error.message); return; }
    reloadCategories();
  }

  async function deleteCategory(id,name){
    setBusy(true);
    const {error} = await client.from('categories').delete().eq('id',id);
    setBusy(false);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast('Categoria "'+name+'" removida');
    reloadCategories();
  }

  async function saveRename(id){
    const name = editingName.trim();
    if(!name){ setEditingId(null); return; }
    setBusy(true);
    const {error} = await client.from('categories').update({name}).eq('id',id);
    setBusy(false);
    setEditingId(null);
    if(error){ showToast('Erro: '+error.message); return; }
    reloadCategories();
  }

  async function addUser(){
    const name = newUser.trim();
    if(!name) return;
    if((users||[]).some(u=>u.name.toLowerCase()===name.toLowerCase())){
      showToast('Esse usuário já existe'); return;
    }
    setBusy(true);
    const {error} = await client.from('users').insert({name});
    setBusy(false);
    if(error){ showToast('Erro: '+error.message); return; }
    setNewUser('');
    reloadUsers();
  }

  async function deleteUser(id,name){
    if((users||[]).length<=1){ showToast('Precisa ter pelo menos um usuário'); return; }
    setBusy(true);
    const {error} = await client.from('users').delete().eq('id',id);
    setBusy(false);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast('Usuário "'+name+'" removido');
    reloadUsers();
  }

  async function saveRenameUser(id){
    const name = editingUserName.trim();
    if(!name){ setEditingUserId(null); return; }
    setBusy(true);
    const {error} = await client.from('users').update({name}).eq('id',id);
    setBusy(false);
    setEditingUserId(null);
    if(error){ showToast('Erro: '+error.message); return; }
    reloadUsers();
  }

  async function addCard(){
    const name = newCard.trim();
    if(!name) return;
    if((cards||[]).some(c=>c.name.toLowerCase()===name.toLowerCase())){
      showToast('Esse cartão já existe'); return;
    }
    setBusy(true);
    const {error} = await client.from('cards').insert({name, account_type: newCardType});
    setBusy(false);
    if(error){ showToast('Erro: '+error.message); return; }
    setNewCard(''); setNewCardType('credit');
    reloadCards();
  }

  async function deleteCard(id,name){
    setBusy(true);
    const {error} = await client.from('cards').delete().eq('id',id);
    setBusy(false);
    if(error){ showToast('Erro: '+error.message); return; }
    showToast('Cartão "'+name+'" removido');
    reloadCards();
  }

  async function saveRenameCard(id){
    const name = editingCardName.trim();
    if(!name){ setEditingCardId(null); return; }
    setBusy(true);
    const {error} = await client.from('cards').update({name}).eq('id',id);
    setBusy(false);
    setEditingCardId(null);
    if(error){ showToast('Erro: '+error.message); return; }
    reloadCards();
  }

  const body = (
    <div>
      {!embedded && <div className="section-title" style={{marginTop:30}}>Configurar Supabase</div>}
      {embedded && <div className="section-title">Configuração</div>}

      {embedded && client && plaidPending.length>0 && (
        <div className="card" style={{borderColor:'var(--amber)'}}>
          <div style={{fontWeight:700,marginBottom:6,color:'var(--amber)'}}>⚠️ {plaidPending.length} conta(s) do Plaid esperando associação</div>
          <p className="muted" style={{marginBottom:14}}>O login trouxe mais de uma conta. Escolhe qual cartão cadastrado é cada uma, ou cria um novo.</p>
          {plaidPending.map(conn=>{
            const draft = assignDrafts[conn.id] || {mode:'new',cardId:'',newName:''};
            return (
              <div key={conn.id} style={{marginBottom:14,paddingBottom:14,borderBottom:'1px dashed var(--bezel)'}}>
                <div className="ledger-desc" style={{marginBottom:8}}>{conn.institution_name ? conn.institution_name+' — ' : ''}{conn.account_name}</div>
                <div className="row2" style={{marginBottom:8}}>
                  <button className={"btn btn-sm "+(draft.mode==='existing'?'btn-primary':'btn-ghost')} onClick={()=>setAssignDrafts({...assignDrafts,[conn.id]:{...draft,mode:'existing'}})}>Cartão existente</button>
                  <button className={"btn btn-sm "+(draft.mode==='new'?'btn-primary':'btn-ghost')} onClick={()=>setAssignDrafts({...assignDrafts,[conn.id]:{...draft,mode:'new'}})}>Criar novo</button>
                </div>
                {draft.mode==='existing' ? (
                  <select value={draft.cardId} onChange={ev=>setAssignDrafts({...assignDrafts,[conn.id]:{...draft,cardId:ev.target.value}})}>
                    <option value="">Selecione o cartão…</option>
                    {(cards||[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                ) : (
                  <input value={draft.newName} onChange={ev=>setAssignDrafts({...assignDrafts,[conn.id]:{...draft,newName:ev.target.value}})} placeholder={'Nome do cartão (ex: '+conn.account_name+')'} />
                )}
              </div>
            );
          })}
          <button className="btn btn-primary" onClick={confirmAssignments} disabled={assigning}>
            {assigning ? <span className="spinner"></span> : 'Confirmar associações'}
          </button>
        </div>
      )}

      {embedded && client && (
        <div className="card">
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <div style={{fontWeight:700,fontSize:14}}>Cartões / Fontes</div>
            {Object.values(plaidConns).filter(c=>c.status==='connected').length>0 && (
              <span className="tag">{Object.values(plaidConns).filter(c=>c.status==='connected').length} de 10 conectadas (Plaid)</span>
            )}
          </div>
          {(cards||[]).length===0 && <p className="muted">Nenhum cartão cadastrado ainda. Adicione abaixo, ou cadastre direto na hora de lançar/importar um gasto.</p>}
          {(cards||[]).map(c=>{
            const conn = plaidConns[c.id];
            const isConnected = conn?.status==='connected';
            return (
              <div key={c.id} style={{padding:'10px 2px',borderBottom:'1px dashed var(--bezel)'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  {editingCardId===c.id ? (
                    <input
                      autoFocus
                      value={editingCardName}
                      onChange={e=>setEditingCardName(e.target.value)}
                      onBlur={()=>saveRenameCard(c.id)}
                      onKeyDown={e=>{ if(e.key==='Enter') saveRenameCard(c.id); }}
                      style={{flex:1,marginRight:8}}
                    />
                  ) : (
                    <div>
                      <div className="ledger-desc" style={{cursor:'pointer'}} onClick={()=>{setEditingCardId(c.id);setEditingCardName(c.name);}}>{c.name}</div>
                      <div style={{display:'flex',alignItems:'center',gap:5,marginTop:3}}>
                        <span style={{width:7,height:7,borderRadius:'50%',background:isConnected?'var(--green)':'var(--red)',display:'inline-block'}}></span>
                        <span className="muted" style={{fontSize:11}}>{isConnected ? 'Conectado ao banco'+(conn.last_synced_at?' · sincronizado':' · nunca sincronizado') : 'Desconectado'}</span>
                      </div>
                    </div>
                  )}
                  <div style={{display:'flex',gap:12,alignItems:'center'}}>
                    {isConnected ? (
                      <>
                        <span className="link" onClick={()=>syncCard(c.id,c.name)}>{syncingCardId===c.id && connectingCardId!==c.id ? <span className="spinner"></span> : 'sincronizar'}</span>
                        <span className="link" style={{color:'var(--red)'}} onClick={()=>disconnectCard(c.id,c.name)}>desconectar</span>
                      </>
                    ) : (
                      <span className="link" style={{color:'var(--amber)'}} onClick={()=>connectCard(c.id,c.name)}>{connectingCardId===c.id ? <span className="spinner"></span> : 'conectar'}</span>
                    )}
                    <span className="link" onClick={()=>{setEditingCardId(c.id);setEditingCardName(c.name);}}>editar</span>
                    <span className="link" style={{color:'var(--red)'}} onClick={()=>deleteCard(c.id,c.name)}>excluir</span>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="row2" style={{marginTop:12,alignItems:'flex-end'}}>
            <div className="field" style={{marginBottom:0,flex:1}}>
              <input value={newCard} onChange={e=>setNewCard(e.target.value)} placeholder="Ex: Capital One Quicksilver" onKeyDown={e=>{ if(e.key==='Enter') addCard(); }} />
            </div>
            <select value={newCardType} onChange={e=>setNewCardType(e.target.value)} style={{flex:'0 0 auto',width:'auto'}}>
              <option value="credit">Crédito</option>
              <option value="bank">Conta</option>
            </select>
            <button className="btn btn-primary btn-sm" style={{flex:'0 0 auto'}} onClick={addCard} disabled={busy}>Adicionar</button>
          </div>
        </div>
      )}

      {embedded && client && (
        <div className="card">
          <div style={{fontWeight:700,marginBottom:10,fontSize:14}}>Usuários</div>
          {(users||[]).length===0 && <p className="muted">Carregando…</p>}
          {(users||[]).map(u=>(
            <div key={u.id} className="ledger-row" style={{padding:'8px 2px'}}>
              {editingUserId===u.id ? (
                <input
                  autoFocus
                  value={editingUserName}
                  onChange={e=>setEditingUserName(e.target.value)}
                  onBlur={()=>saveRenameUser(u.id)}
                  onKeyDown={e=>{ if(e.key==='Enter') saveRenameUser(u.id); }}
                  style={{flex:1,marginRight:8}}
                />
              ) : (
                <div className="ledger-desc" style={{cursor:'pointer'}} onClick={()=>{setEditingUserId(u.id);setEditingUserName(u.name);}}>{u.name}</div>
              )}
              <div style={{display:'flex',gap:14}}>
                <span className="link" onClick={()=>{setEditingUserId(u.id);setEditingUserName(u.name);}}>editar</span>
                <span className="link" style={{color:'var(--red)'}} onClick={()=>deleteUser(u.id,u.name)}>excluir</span>
              </div>
            </div>
          ))}
          <div className="row2" style={{marginTop:12,alignItems:'flex-end'}}>
            <div className="field" style={{marginBottom:0,flex:1}}>
              <input value={newUser} onChange={e=>setNewUser(e.target.value)} placeholder="Nome do novo usuário" onKeyDown={e=>{ if(e.key==='Enter') addUser(); }} />
            </div>
            <button className="btn btn-primary btn-sm" style={{flex:'0 0 auto'}} onClick={addUser} disabled={busy}>Adicionar</button>
          </div>
          <p className="muted" style={{marginTop:10}}>Com 2 ou mais usuários, aparece um seletor no topo do app e você escolhe o responsável em cada gasto.</p>
        </div>
      )}

      {embedded && client && (
        <div className="card">
          <div style={{fontWeight:700,marginBottom:10,fontSize:14}}>Categorias</div>
          {(categories||[]).length===0 && <p className="muted">Carregando…</p>}
          {(categories||[]).map(c=>(
            <div key={c.id} style={{padding:'8px 2px',borderBottom:'1px dashed var(--bezel)'}}>
              <div className="ledger-row" style={{border:'none',padding:0}}>
                {editingId===c.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={e=>setEditingName(e.target.value)}
                    onBlur={()=>saveRename(c.id)}
                    onKeyDown={e=>{ if(e.key==='Enter') saveRename(c.id); }}
                    style={{flex:1,marginRight:8}}
                  />
                ) : (
                  <div className="ledger-desc" style={{cursor:'pointer'}} onClick={()=>{setEditingId(c.id);setEditingName(c.name);}}>
                    {c.name}{c.is_credit && <span className="tag" style={{marginLeft:6,color:'var(--green)'}}>💳 crédito</span>}
                  </div>
                )}
                <div style={{display:'flex',gap:14}}>
                  <span className="link" onClick={()=>{setEditingId(c.id);setEditingName(c.name);}}>editar</span>
                  <span className="link" style={{color:'var(--red)'}} onClick={()=>deleteCategory(c.id,c.name)}>excluir</span>
                </div>
              </div>
              <label style={{display:'flex',gap:6,alignItems:'center',marginTop:6,fontSize:11.5}}>
                <input type="checkbox" checked={!!c.is_credit} onChange={e=>toggleCategoryCredit(c.id,e.target.checked)} />
                Não contar como despesa (crédito)
              </label>
            </div>
          ))}
          <div className="row2" style={{marginTop:12,alignItems:'flex-end'}}>
            <div className="field" style={{marginBottom:0,flex:1}}>
              <input value={newCat} onChange={e=>setNewCat(e.target.value)} placeholder="Nova categoria" onKeyDown={e=>{ if(e.key==='Enter') addCategory(); }} />
            </div>
            <button className="btn btn-primary btn-sm" style={{flex:'0 0 auto'}} onClick={addCategory} disabled={busy}>Adicionar</button>
          </div>
          <label style={{display:'flex',gap:6,alignItems:'center',marginTop:8,fontSize:11.5}}>
            <input type="checkbox" checked={newCatIsCredit} onChange={e=>setNewCatIsCredit(e.target.checked)} />
            Nova categoria é crédito (não contar como despesa)
          </label>
          <p className="muted" style={{marginTop:10}}>Excluir uma categoria não altera gastos já lançados com ela, só some das opções futuras. Categorias marcadas como crédito (ex: "Pagamento Efetuado") não entram na soma de despesas — aparecem à parte no Resumo.</p>
        </div>
      )}

      <div className="card">
        <p className="muted" style={{marginBottom:12}}>
          Crie um projeto grátis em supabase.com, rode o SQL abaixo na aba SQL Editor, e cole a URL e a chave anon aqui.
        </p>
        <div className="field">
          <label>Supabase URL</label>
          <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
        </div>
        <div className="field">
          <label>Supabase anon key</label>
          <input value={key} onChange={e=>setKey(e.target.value)} placeholder="eyJhbGciOi..." />
        </div>
        <button className="btn btn-primary" onClick={()=>{onSave({url:url.trim(),key:key.trim()}); setMsg('Salvo ✓');}}>Salvar configuração</button>
        {(url!==BUILTIN_SUPABASE_URL || key!==BUILTIN_SUPABASE_KEY) && (
          <button className="btn btn-ghost" style={{marginTop:8}} onClick={()=>{
            setUrl(BUILTIN_SUPABASE_URL); setKey(BUILTIN_SUPABASE_KEY);
            onSave({url:BUILTIN_SUPABASE_URL,key:BUILTIN_SUPABASE_KEY});
            setMsg('Restaurado pro padrão ✓');
          }}>Restaurar padrão</button>
        )}
        {msg && <p className="muted" style={{marginTop:8}}>{msg}</p>}
      </div>
      <div className="card">
        <div style={{fontWeight:700,marginBottom:8,fontSize:13}}>SQL para rodar no Supabase</div>
        <textarea readOnly rows="14" style={{fontFamily:'JetBrains Mono, monospace',fontSize:11.5}} value={SQL_SCHEMA}></textarea>
      </div>
    </div>
  );
  if(embedded) return body;
  return <div className="app"><div className="content">{body}</div></div>;
}

const SQL_SCHEMA = `create extension if not exists "uuid-ossp";

create table if not exists expenses (
  id uuid primary key default uuid_generate_v4(),
  description text not null,
  amount numeric not null,
  category text,
  card text,
  date date not null,
  added_by text not null,
  source text default 'manual',
  created_at timestamp default now()
);

alter table expenses add column if not exists card text;
alter table expenses add column if not exists is_recurring boolean default false;

alter table expenses enable row level security;

create policy "anyone_select_expenses" on expenses for select using (true);
create policy "anyone_insert_expenses" on expenses for insert with check (true);
create policy "anyone_delete_expenses" on expenses for delete using (true);
create policy "anyone_update_expenses" on expenses for update using (true);

create table if not exists categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  created_at timestamp default now()
);

alter table categories enable row level security;

alter table categories add column if not exists is_credit boolean default false;

create policy "anyone_select_categories" on categories for select using (true);
create policy "anyone_insert_categories" on categories for insert with check (true);
create policy "anyone_delete_categories" on categories for delete using (true);
create policy "anyone_update_categories" on categories for update using (true);

create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  created_at timestamp default now()
);

alter table users enable row level security;

create policy "anyone_select_users" on users for select using (true);
create policy "anyone_insert_users" on users for insert with check (true);
create policy "anyone_delete_users" on users for delete using (true);
create policy "anyone_update_users" on users for update using (true);

create table if not exists cards (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  created_at timestamp default now()
);

alter table cards enable row level security;

create policy "anyone_select_cards" on cards for select using (true);
create policy "anyone_insert_cards" on cards for insert with check (true);
create policy "anyone_delete_cards" on cards for delete using (true);
create policy "anyone_update_cards" on cards for update using (true);

alter table cards add column if not exists manual_limit numeric;
alter table cards add column if not exists manual_balance numeric;
alter table cards add column if not exists manual_balance_updated_at timestamp;
alter table cards add column if not exists account_type text default 'credit';

-- Conexoes com o Plaid: guarda o access_token de cada conta bancaria conectada.
-- RLS ativado SEM nenhuma politica = ninguem com a chave publica (anon/publishable)
-- consegue ler ou escrever aqui. So a service_role key (usada apenas no servidor,
-- nunca no navegador) tem acesso, porque ela ignora RLS por definicao do Supabase.
create table if not exists plaid_connections (
  id uuid primary key default uuid_generate_v4(),
  card_id uuid references cards(id) on delete cascade,
  institution_name text,
  account_name text,
  plaid_item_id text,
  plaid_access_token text,
  plaid_account_id text,
  status text default 'connected',
  cursor text,
  last_synced_at timestamp,
  current_balance numeric,
  available_balance numeric,
  credit_limit numeric,
  iso_currency_code text,
  balance_updated_at timestamp,
  created_at timestamp default now()
);

alter table plaid_connections alter column plaid_access_token drop not null;
alter table plaid_connections add column if not exists current_balance numeric;
alter table plaid_connections add column if not exists available_balance numeric;
alter table plaid_connections add column if not exists credit_limit numeric;
alter table plaid_connections add column if not exists iso_currency_code text;
alter table plaid_connections add column if not exists balance_updated_at timestamp;

alter table plaid_connections enable row level security;

-- Um "Item" do Plaid = um login no banco, pode ter varias contas dentro (checking,
-- business checking, linha de credito, etc.) O token fica guardado aqui UMA vez por
-- login; plaid_connections representa cada CONTA especifica dentro do login,
-- e aponta pra qual cartao ela foi associada.
create table if not exists plaid_items (
  id uuid primary key default uuid_generate_v4(),
  plaid_item_id text,
  plaid_access_token text not null,
  institution_name text,
  cursor text,
  last_synced_at timestamp,
  created_at timestamp default now()
);

alter table plaid_items enable row level security;

alter table plaid_connections add column if not exists item_ref uuid references plaid_items(id) on delete cascade;

-- Transações vindas de sincronização automática do Plaid (cron, "Sincronizar tudo") que
-- parecem duplicatas de algo já lançado (mesma data+valor+cartão, descrição diferente).
-- Como a sincronização roda sozinha sem tela pra perguntar na hora, ficam guardadas aqui
-- esperando alguém revisar manualmente no app.
create table if not exists plaid_pending_transactions (
  id uuid primary key default uuid_generate_v4(),
  description text not null,
  amount numeric not null,
  category text,
  card text,
  date date not null,
  added_by text not null,
  matched_description text,
  created_at timestamp default now()
);

alter table plaid_pending_transactions enable row level security;

create policy "anyone_select_plaid_pending" on plaid_pending_transactions for select using (true);
create policy "anyone_insert_plaid_pending" on plaid_pending_transactions for insert with check (true);
create policy "anyone_delete_plaid_pending" on plaid_pending_transactions for delete using (true);
create policy "anyone_update_plaid_pending" on plaid_pending_transactions for update using (true);

-- Contas a pagar, organizadas por mes (cartoes de credito + contas avulsas tipo
-- mortgage, AT&T, etc.) O expense_id liga com o lancamento criado quando o
-- valor pago e preenchido, pra atualizar em vez de duplicar.
create table if not exists bills_to_pay (
  id uuid primary key default uuid_generate_v4(),
  month_key text not null,
  card_id uuid references cards(id) on delete set null,
  description text not null,
  open_amount numeric,
  minimum_payment numeric,
  paid_amount numeric,
  paid_date date,
  expense_id uuid references expenses(id) on delete set null,
  created_at timestamp default now()
);

alter table bills_to_pay enable row level security;

create policy "anyone_select_bills" on bills_to_pay for select using (true);
create policy "anyone_insert_bills" on bills_to_pay for insert with check (true);
create policy "anyone_delete_bills" on bills_to_pay for delete using (true);
create policy "anyone_update_bills" on bills_to_pay for update using (true);

create unique index if not exists bills_to_pay_month_card_uidx on bills_to_pay(month_key, card_id) where card_id is not null;
`;

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
