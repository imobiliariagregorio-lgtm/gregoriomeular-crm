// =====================================================================
// FUNIL DE CONSÓRCIO + PAINEL — módulo independente do CRM
// Gregório | Meu Lar Imobiliária
//
// Carregado DEPOIS do app.js (<script src="js/funil-consorcio.js"></script>).
// Não altera o app.js: cria sozinho os dois itens de menu e as duas telas.
// Usa só o que o CRM já oferece: supabase, currentUsuario, navigateTo, toast.
// A regra de cadência (quando lembrar) fica no banco, na tabela
// consorcio_cadencia; o quadro só mostra o resultado (RPC consorcio_leads_com_acao).
// =====================================================================
(function () {
  'use strict';

  // ---- segurança: se o CRM não tiver o que precisamos, não faz nada ----
  if (typeof supabase === 'undefined' || typeof navigateTo !== 'function') {
    console.warn('[funil-consorcio] CRM não encontrado (supabase/navigateTo). Módulo não iniciado.');
    return;
  }

  const INTERESSES = ['consorcio', 'carta_contemplada'];

  // Etapas do funil de consórcio (os nomes são os do banco)
  const ETAPAS = [
    ['novo', 'Novo'], ['tentativa_1', '1ª tentativa'], ['tentativa_2', '2ª tentativa'], ['tentativa_3', '3ª tentativa'],
    ['busca_qualificada', 'Qualificado'], ['consulta_simulacao', 'Simulação enviada'], ['alterar_busca', 'Ajustando o plano'],
    ['proposta', 'Proposta enviada'], ['documentacao', 'Documentação'], ['assinaturas', 'Assinaturas (adesão)'],
    ['pos_venda_30', 'Pós-venda 30 dias'], ['pos_venda_60', 'Pós-venda 60 dias'], ['pos_venda_90', 'Pós-venda 90 dias'],
    ['pos_venda_120', 'Pós-venda 120 dias'], ['acompanhar_depois', 'Acompanhar depois'], ['perdido', 'Perdido'],
  ];
  const ROTULO = Object.fromEntries(ETAPAS);
  ROTULO.perdido_definitivo = 'Perdido (definitivo)';

  // Colunas do quadro (agrupam etapas parecidas)
  const COLUNAS = [
    { id: 'novo', titulo: 'Novo', dica: 'Primeiro contato em até 1 hora', st: ['novo'] },
    { id: 'contato', titulo: 'Em contato', dica: 'Até 3 tentativas', st: ['tentativa_1', 'tentativa_2', 'tentativa_3'] },
    { id: 'qualificado', titulo: 'Qualificado', dica: 'Já sabemos bem, crédito e parcela', st: ['busca_qualificada'] },
    { id: 'simulacao', titulo: 'Simulação', dica: 'Plano e parcela enviados', st: ['consulta_simulacao'] },
    { id: 'ajuste', titulo: 'Ajustando o plano', dica: 'Pediu outro crédito, prazo ou Flex', st: ['alterar_busca'] },
    { id: 'proposta', titulo: 'Proposta', dica: 'Grupo e cota definidos', st: ['proposta'] },
    { id: 'documentacao', titulo: 'Documentação', dica: 'Cadastro na administradora', st: ['documentacao'] },
    { id: 'assinaturas', titulo: 'Assinaturas', dica: 'Adesão em fechamento', st: ['assinaturas'] },
    { id: 'posvenda', titulo: 'Pós-venda', dica: 'Aqui está o dinheiro do consórcio', st: ['pos_venda_30', 'pos_venda_60', 'pos_venda_90', 'pos_venda_120'] },
    { id: 'acompanhar', titulo: 'Acompanhar depois', dica: 'Tem potencial, retomada combinada', st: ['acompanhar_depois'] },
    { id: 'outras', titulo: 'Outras etapas', dica: 'Etapas que o consórcio não usa', st: ['visita_agendada', 'visita_feita'], ocultaSeVazia: true },
  ];

  // ---------- utilitários ----------
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const brl = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const qs = (sel, ctx) => (ctx || document).querySelector(sel);
  const gestao = () => typeof currentUsuario !== 'undefined' && currentUsuario && ['admin', 'gerente'].includes(currentUsuario.cargo);
  const aviso = (msg, erro) => { if (typeof toast === 'function') toast(msg, !!erro); else console.log(msg); };
  const linkWhats = (tel) => {
    const d = String(tel || '').replace(/\D/g, '');
    if (d.length < 10) return '';
    return 'https://wa.me/' + (d.startsWith('55') ? d : '55' + d);
  };
  const diasNaEtapa = (l) => Math.max(0, Math.floor((Date.now() - new Date(l.status_alterado_em || l.criado_em).getTime()) / 86400000));
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const hojeISO = () => new Date().toLocaleDateString('en-CA');                       // AAAA-MM-DD no fuso do usuário
  const somaDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const dataBR = (iso) => { if (!iso) return ''; const [a, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${a}`; };
  const diasAte = (iso) => Math.round((new Date(iso + 'T00:00:00') - new Date(hojeISO() + 'T00:00:00')) / 86400000);   // >0 = no futuro

  // ---------- estilo (usa as variáveis de cor do CRM) ----------
  const css = `
    .filters-bar-label input[type=checkbox]{padding:0;width:auto;}
    .fc-busca{position:relative;flex:1 1 300px;max-width:440px;}
    .fc-busca input{width:100%;box-sizing:border-box;padding-right:36px;}
    .fc-busca button{position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--gray-text,#C9D2E0);cursor:pointer;font-size:1rem;padding:6px 10px;}
    .kanban-card.fc-achado{border-color:var(--orange,#FF6A1A);box-shadow:0 0 0 1px var(--orange,#FF6A1A);}
    .fc-sem-resultado{padding:34px 12px;text-align:center;}
    @media (max-width:640px){.fc-busca{flex-basis:100%;max-width:none;}}
    .fc-resumo{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 14px;}
    .fc-pilula{background:var(--navy-700,#14335c);border:1px solid rgba(255,255,255,.06);border-radius:20px;padding:5px 13px;font-size:.78rem;color:var(--gray-text,#9aa7b8);}
    .fc-pilula b{color:var(--orange,#F58220);}
    .fc-pilula.fc-alerta b{color:#ff7b84;}
    .fc-nota{font-size:.75rem;color:var(--gray-text,#9aa7b8);margin:0 0 12px;}
    .fc-col-dica{display:block;font-size:.68rem;font-weight:400;color:var(--gray-text,#9aa7b8);}
    .fc-chip{display:inline-block;background:rgba(255,255,255,.07);border-radius:6px;padding:1px 7px;font-size:.68rem;color:var(--gray-text,#9aa7b8);margin:0 4px 3px 0;}
    .fc-etapa{font-size:.68rem;color:var(--orange,#F58220);font-weight:700;}
    .fc-tempo{font-size:.7rem;color:var(--gray-text,#9aa7b8);}
    .fc-tempo.fc-vencido{color:#ff7b84;font-weight:700;}
    .fc-acao{background:rgba(224,85,95,.14);border:1px solid rgba(224,85,95,.45);border-radius:7px;padding:4px 7px;font-size:.7rem;color:#ff9aa1;}
    .fc-card-nome{display:flex;justify-content:space-between;gap:6px;align-items:baseline;}
    .fc-zap{font-size:.7rem;text-decoration:none;color:#4caf7d;white-space:nowrap;}
    .fc-mover{width:100%;font-size:.72rem;}
    .fc-barra-linha{display:grid;grid-template-columns:130px 1fr 110px;gap:10px;align-items:center;margin:7px 0;font-size:.82rem;}
    .fc-trilho{background:var(--navy-800,#0d2340);border-radius:8px;height:20px;overflow:hidden;}
    .fc-barra{background:var(--orange,#F58220);height:100%;border-radius:8px;min-width:2px;}
    .fc-barra.fc-verde{background:#4caf7d;}
    .fc-num{text-align:right;color:var(--gray-text,#9aa7b8);}
    .fc-num b{color:var(--white,#fff);}
    .fc-modal{position:fixed;inset:0;background:rgba(3,10,25,.72);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;}
    .fc-modal-box{background:var(--navy-700,#142B57);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:22px;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.5);}
    .fc-modal-box h3{margin:0 0 4px;font-size:1.05rem;}
    .fc-modal-sub{font-size:.8rem;margin:0 0 14px;}
    .fc-modal-box label{display:block;font-size:.76rem;color:var(--gray-text,#C9D2E0);margin:12px 0 4px;}
    .fc-modal-box input[type=date],.fc-modal-box input[type=text]{width:100%;box-sizing:border-box;background:var(--navy-800,#0B1E3D);border:1px solid var(--navy-600,#1D3A6E);color:var(--white,#fff);padding:9px 10px;border-radius:8px;font-size:.9rem;}
    .fc-rapido{display:flex;flex-wrap:wrap;gap:6px;}
    .fc-rapido button{background:var(--navy-800,#0B1E3D);border:1px solid var(--navy-600,#1D3A6E);color:var(--white,#fff);border-radius:20px;padding:8px 14px;font-size:.8rem;cursor:pointer;}
    .fc-modal-acoes .btn{min-height:42px;padding:10px 20px;font-size:.88rem;}
    .fc-rapido button:hover{border-color:var(--orange,#FF6A1A);}
    .fc-modal-aviso{background:rgba(255,182,72,.12);border:1px solid rgba(255,182,72,.5);border-radius:8px;padding:8px 10px;font-size:.76rem;color:#ffcf85;margin:12px 0 0;}
    .fc-modal-acoes{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;}
    .fc-aviso-decida{background:rgba(255,182,72,.12);border:1px solid rgba(255,182,72,.5);border-radius:7px;padding:4px 7px;font-size:.7rem;color:#ffcf85;}
    .fc-grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:16px;}
    .fc-duas{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-top:14px;}
    .fc-duas .panel{overflow-x:auto;}
    .fc-grade .stat-value{font-size:clamp(1.2rem,1.7vw,1.55rem);white-space:nowrap;}
    .fc-clicavel{cursor:pointer;transition:transform .12s,box-shadow .12s;}
    .fc-clicavel:hover,.fc-clicavel:focus-visible{transform:translateY(-2px);outline:none;box-shadow:0 0 0 1px var(--orange,#FF6A1A);}
    .fc-card-dica{font-size:.72rem;color:var(--orange,#FF6A1A);margin-top:6px;font-weight:600;}
    .fc-card-dica.fc-ok{color:#6fd3a0;}
    .fc-link{background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;text-decoration:underline dotted;}
    .fc-link:hover{color:var(--orange,#FF6A1A);}
    .fc-fazer-item{display:grid;grid-template-columns:1fr auto;gap:6px 14px;align-items:center;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.07);}
    .fc-fazer-item:last-child{border-bottom:0;}
    .fc-fazer-nome{font-weight:700;}
    .fc-fazer-texto{font-size:.85rem;margin-top:2px;}
    .fc-fazer-meta{font-size:.72rem;color:var(--gray-text,#C9D2E0);margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
    .fc-fazer-botoes{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
    .fc-fazer-botoes a{text-decoration:none;}
    .fc-cota{background:var(--navy-700,#142B57);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;margin-bottom:10px;display:grid;grid-template-columns:1fr auto;gap:8px 16px;}
    .fc-cota-fim{opacity:.62;}
    .fc-cota-lado{display:flex;flex-direction:column;align-items:flex-end;gap:8px;}
    .fc-sit{border-radius:20px;padding:4px 12px;font-size:.74rem;font-weight:700;white-space:nowrap;}
    .fc-sit-enviar{background:rgba(255,106,26,.18);color:var(--orange,#FF6A1A);border:1px solid var(--orange,#FF6A1A);}
    .fc-sit-esp{background:rgba(255,255,255,.07);color:var(--gray-text,#C9D2E0);}
    .fc-sit-ok{background:rgba(76,175,125,.18);color:#6fd3a0;}
    .fc-sit-fim{background:rgba(255,255,255,.05);color:var(--gray-text,#C9D2E0);}
    .fc-modal-box.fc-modal-grande{max-width:560px;max-height:92vh;overflow:auto;}
    .fc-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;}
    .fc-modal-box input[type=number],.fc-modal-box select{width:100%;box-sizing:border-box;background:var(--navy-800,#0B1E3D);border:1px solid var(--navy-600,#1D3A6E);color:var(--white,#fff);padding:9px 10px;border-radius:8px;font-size:.9rem;}
    .fc-conferido{display:flex;gap:8px;align-items:center;margin-top:12px;font-size:.8rem;}
    .fc-conferido input{width:auto;}
    @media (max-width:640px){.fc-cota{grid-template-columns:1fr;}.fc-cota-lado{align-items:flex-start;}.fc-form-grid{grid-template-columns:1fr;}}
    @media (max-width:640px){.fc-fazer-item{grid-template-columns:1fr;}.fc-fazer-botoes{justify-content:flex-start;}}
    .fc-tab{width:100%;border-collapse:collapse;font-size:.82rem;}
    .fc-tab th{text-align:left;color:var(--gray-text,#9aa7b8);font-weight:600;padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.08);}
    .fc-tab td{padding:6px;border-bottom:1px solid rgba(255,255,255,.04);}
    .fc-tab td.fc-r,.fc-tab th.fc-r{text-align:right;}
    .fc-tab td.fc-nome{max-width:115px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .fc-duas .fc-tab th,.fc-duas .fc-tab td{padding:6px 4px;}
    @media (max-width:640px){.fc-barra-linha{grid-template-columns:96px 1fr 84px;gap:6px;font-size:.74rem;}}
  `;
  const estilo = document.createElement('style');
  estilo.id = 'fc-estilo';
  estilo.textContent = css;
  document.head.appendChild(estilo);

  // ---------- telas e menu (criados aqui, sem mexer no index.html) ----------
  function criarTela(id, html) {
    if (document.getElementById('view-' + id)) return;
    const sec = document.createElement('section');
    sec.className = 'view';
    sec.id = 'view-' + id;
    sec.hidden = true;
    sec.innerHTML = html;
    const ref = document.getElementById('view-funil');
    if (ref && ref.parentElement) ref.insertAdjacentElement('afterend', sec);
    else (document.querySelector('main') || document.body).appendChild(sec);
  }

  criarTela('funil_consorcio', `
    <div class="view-head">
      <div><h1>Funil de Consórcio</h1><p>Do primeiro contato à adesão e ao pós-venda</p></div>
      <button class="btn btn-ghost btn-sm" id="fcAtualizar">Atualizar</button>
    </div>
    <div class="filters-bar" id="fcFiltros">
      <div class="fc-busca">
        <input type="text" id="fcBusca" placeholder="Buscar cliente por nome ou telefone" autocomplete="off" enterkeyhint="search" aria-label="Buscar cliente por nome ou telefone">
        <button type="button" id="fcBuscaLimpar" title="Limpar a busca" aria-label="Limpar a busca" hidden>✕</button>
      </div>
      <select id="fcFiltroCorretor" hidden><option value="">Todos os corretores</option></select>
      <label class="filters-bar-label"><input type="checkbox" id="fcSoAcao"> Só os que pedem ação</label>
      <label class="filters-bar-label"><input type="checkbox" id="fcMostrarPerdidos"> Mostrar perdidos</label>
    </div>
    <div class="fc-resumo" id="fcResumo"></div>
    <p class="fc-nota">Lembretes automáticos: de segunda a sábado, às 8h, o CRM cria uma tarefa no Dashboard (e manda um e-mail) para cada lead parado. Nunca prometa contemplação ao cliente.</p>
    <div class="kanban-board" id="fcBoard"></div>`);

  criarTela('painel_consorcio', `
    <div class="view-head">
      <div><h1>Painel de Consórcio</h1><p>Como está o funil e onde ele está vazando</p></div>
      <button class="btn btn-ghost btn-sm" id="pcAtualizar">Atualizar</button>
    </div>
    <div class="filters-bar">
      <select id="pcPeriodo">
        <option value="7">Últimos 7 dias</option><option value="30" selected>Últimos 30 dias</option>
        <option value="90">Últimos 90 dias</option><option value="365">Últimos 12 meses</option>
      </select>
      <select id="pcCorretor" hidden><option value="">Todos os corretores</option></select>
    </div>
    <div id="pcConteudo"><p class="table-empty">Carregando…</p></div>`);

  criarTela('cotas_consorcio', `
    <div class="view-head">
      <div><h1>Cotas fechadas</h1><p>Valor, vencimento e lembrete para enviar o boleto antes de vencer</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" data-fc="cota-nova">+ Registrar cota</button>
        <button class="btn btn-ghost btn-sm" id="ctAtualizar">Atualizar</button>
      </div>
    </div>
    <div class="filters-bar">
      <select id="ctCorretor" hidden><option value="">Todos os corretores</option></select>
      <label class="filters-bar-label"><input type="checkbox" id="ctEncerradas"> Mostrar encerradas</label>
    </div>
    <div class="fc-resumo" id="ctResumo"></div>
    <div id="ctLista"><p class="table-empty">Carregando…</p></div>`);

  function criarMenu() {
    const painel = qs('.topnav-dropdown[data-group-panel="vendas"]');
    if (!painel) { console.warn('[funil-consorcio] menu "Vendas" não encontrado.'); return; }
    // os dois itens entram logo depois do "Funil de Vendas" (ou no começo do menu, se ele não existir)
    let ancora = qs('.nav-item[data-view="funil"]', painel);
    [['funil_consorcio', '🏦 Funil de Consórcio'], ['painel_consorcio', '📊 Painel de Consórcio'], ['cotas_consorcio', '💳 Cotas fechadas']].forEach(([view, texto]) => {
      let btn = qs(`.nav-item[data-view="${view}"]`, painel);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'nav-item';
        btn.dataset.view = view;
        btn.textContent = texto;
        btn.addEventListener('click', () => { try { if (typeof limparFiltrosAlerta === 'function') limparFiltrosAlerta(); } catch (e) { /* ignora */ } navigateTo(view); });
        if (ancora) ancora.insertAdjacentElement('afterend', btn);
        else painel.prepend(btn);
      }
      ancora = btn;
    });
  }
  criarMenu();

  // ---------- troca de telas: mostra a nossa e esconde as outras ----------
  const navegarOriginal = navigateTo;
  window.navigateTo = function (view) {
    const minhaTela = view === 'funil_consorcio' || view === 'painel_consorcio' || view === 'cotas_consorcio';
    let falhou = null;
    try { navegarOriginal(view); } catch (e) { falhou = e; }
    // mesmo que o navigateTo original falhe, a tela certa aparece e as outras somem
    document.querySelectorAll('.view').forEach((sec) => { sec.hidden = sec.id !== 'view-' + view; });
    if (falhou) { if (!minhaTela) throw falhou; console.error(falhou); }
    if (view === 'funil_consorcio') carregarFunil();
    if (view === 'painel_consorcio') carregarPainel();
    if (view === 'cotas_consorcio') carregarCotas();
  };

  // =====================================================================
  // 1) QUADRO (KANBAN)
  // =====================================================================
  let corretoresCarregados = false;
  let leadsPorId = new Map();

  async function carregarCorretores(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.hidden = !gestao();
    if (!gestao() || sel.dataset.pronto) return;
    const { data } = await supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome');
    (data || []).forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.nome; sel.appendChild(o); });
    sel.dataset.pronto = '1';
  }

  // ---- busca por nome ou telefone (filtra na tela, sem ir ao banco a cada letra) ----
  const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  function lerBusca() {
    const el = document.getElementById('fcBusca');
    const bruto = (el ? el.value : '').trim();
    if (!bruto) return null;
    if (!/[a-zA-ZÀ-ÿ]/.test(bruto)) {                         // só números (com ou sem traços e parênteses) = telefone
      const digitos = bruto.replace(/\D/g, '');
      if (digitos.length < 3) return null;                       // 1 ou 2 números mostrariam quase todo mundo
      const variantes = [digitos];
      if (digitos.length > 11 && digitos.startsWith('55')) variantes.push(digitos.slice(2));   // aceita o 55 do Brasil
      return { tipo: 'telefone', variantes, texto: bruto };
    }
    const normal = semAcento(bruto);
    if (normal.length < 2) return null;
    return { tipo: 'nome', termos: normal.split(/\s+/).filter(Boolean), texto: bruto };       // todas as palavras, em qualquer ordem
  }

  function bate(l, busca) {
    if (!busca) return true;
    if (busca.tipo === 'telefone') {
      const d = String(l.telefone || '').replace(/\D/g, '');
      return busca.variantes.some((v) => d.includes(v));
    }
    const nome = semAcento(l.nome);
    return busca.termos.every((t) => nome.includes(t));
  }

  let cacheFunil = { todos: [], acao: new Map() };
  let cotasPorLead = new Set();   // leads que já têm cota fechada registrada

  async function carregarFunil() {
    const board = document.getElementById('fcBoard');
    board.innerHTML = '<p class="table-empty">Carregando…</p>';
    await carregarCorretores('fcFiltroCorretor');

    let q = supabase.from('leads').select('*, usuarios(id,nome)').in('interesse', INTERESSES).order('status_alterado_em', { ascending: true }).limit(1000);
    const corretor = document.getElementById('fcFiltroCorretor').value;
    if (gestao()) { if (corretor) q = q.eq('corretor_id', corretor); }
    else if (typeof currentUsuario !== 'undefined' && currentUsuario) q = q.eq('corretor_id', currentUsuario.id);

    const [resLeads, resAcao, resCotas] = await Promise.all([q, supabase.rpc('consorcio_leads_com_acao'), supabase.from('consorcio_cotas').select('lead_id').eq('ativa', true)]);
    if (resLeads.error) { board.innerHTML = '<p class="table-empty">Erro ao carregar o funil de consórcio.</p>'; console.error(resLeads.error); return; }
    const todos = resLeads.data || [];
    leadsPorId = new Map(todos.map((l) => [l.id, l]));
    cacheFunil = { todos, acao: new Map((resAcao.data || []).map((a) => [a.lead_id, a])) };
    cotasPorLead = new Set((resCotas.data || []).map((c) => c.lead_id));
    desenharFunil(false);
    aplicarAoAbrir();
  }

  function desenharFunil(rolarParaAchado) {
    const board = document.getElementById('fcBoard');
    const { todos, acao } = cacheFunil;
    const busca = lerBusca();
    const soAcao = document.getElementById('fcSoAcao').checked;
    const perdidosMarcado = document.getElementById('fcMostrarPerdidos').checked;
    const perdidos = todos.filter((l) => l.status === 'perdido' || l.status === 'perdido_definitivo');
    const ativos = todos.filter((l) => !perdidos.includes(l));
    const lista = (soAcao ? ativos.filter((l) => acao.has(l.id)) : ativos).filter((l) => bate(l, busca));
    // buscando, os perdidos entram na busca mesmo com "Mostrar perdidos" desligado (o cliente pode estar lá)
    const perdidosVisiveis = (!soAcao && (perdidosMarcado || busca)) ? perdidos.filter((l) => bate(l, busca)) : [];
    const base = lista.concat(perdidosVisiveis);

    const emAndamento = ativos.filter((l) => !String(l.status).startsWith('pos_venda_') && l.status !== 'acompanhar_depois').length;
    const acompanhando = ativos.filter((l) => l.status === 'acompanhar_depois').length;
    const clientes = ativos.filter((l) => String(l.status).startsWith('pos_venda_')).length;
    const pedemAcao = ativos.filter((l) => acao.has(l.id)).length;
    document.getElementById('fcResumo').innerHTML =
      (busca ? `<span class="fc-pilula fc-alerta">Encontrados: <b>${base.length}</b></span>` : '') +
      `<span class="fc-pilula">Em andamento: <b>${emAndamento}</b></span>` +
      `<span class="fc-pilula">Em acompanhamento: <b>${acompanhando}</b></span>` +
      `<span class="fc-pilula">Clientes no pós-venda: <b>${clientes}</b></span>` +
      `<span class="fc-pilula ${pedemAcao ? 'fc-alerta' : ''}">Pedem ação: <b>${pedemAcao}</b></span>` +
      `<span class="fc-pilula">Perdidos: <b>${perdidos.length}</b></span>`;

    if (busca && !base.length) {
      const filtros = soAcao || (document.getElementById('fcFiltroCorretor').value);
      board.innerHTML = `<p class="table-empty fc-sem-resultado">Nenhum cliente encontrado para “${esc(busca.texto)}”.` +
        (filtros ? '<br>Há filtros ligados (corretor ou “Só os que pedem ação”). Desligue-os para buscar em todos os leads.' : '') + '</p>';
      return;
    }

    const colunas = COLUNAS.slice();
    if (perdidosMarcado || busca) colunas.push({ id: 'perdidos', titulo: 'Perdidos', dica: 'Motivo registrado no lead', st: ['perdido', 'perdido_definitivo'] });
    const idsAchados = new Set(base.map((l) => l.id));

    board.innerHTML = colunas.map((col) => {
      const doGrupo = base.filter((l) => col.st.includes(l.status));
      if (col.ocultaSeVazia && !doGrupo.length) return '';
      if (busca && !doGrupo.length) return '';                  // buscando, só mostra as colunas com resultado
      return `
        <div class="kanban-col" data-col="${col.id}">
          <div class="kanban-col-head"><span>${esc(col.titulo)}<span class="fc-col-dica">${esc(col.dica)}</span></span><span class="kanban-col-count">${doGrupo.length}</span></div>
          <div class="kanban-cards">
            ${doGrupo.length ? doGrupo.map((l) => cartao(l, acao.get(l.id), col, !!busca && idsAchados.has(l.id))).join('') : '<p class="kanban-empty">Nenhum lead aqui.</p>'}
          </div>
        </div>`;
    }).join('');

    if (rolarParaAchado && busca) {
      const primeiro = board.querySelector('.fc-achado');
      rolarBoardPara(primeiro && primeiro.closest('.kanban-col'));
    }
  }

  // rola só o quadro para o lado (nunca a página inteira, para o campo de busca continuar à vista)
  function rolarBoardPara(coluna) {
    const board = document.getElementById('fcBoard');
    if (!coluna || !board || !board.scrollTo) return;
    const esquerda = coluna.getBoundingClientRect().left - board.getBoundingClientRect().left + board.scrollLeft - 12;
    board.scrollTo({ left: Math.max(0, esquerda), behavior: 'smooth' });
  }

  // ---- vindo do painel: abre o funil já no ponto certo ----
  let aoAbrirFunil = null;   // { coluna: 'acompanhar' } ou { achado: true }

  async function abrirFunil(op) {
    op = op || {};
    await carregarCorretores('fcFiltroCorretor');
    const cor = document.getElementById('fcFiltroCorretor');
    const pc = document.getElementById('pcCorretor');
    if (gestao() && cor && pc && [...cor.options].some((o) => o.value === pc.value)) cor.value = pc.value;   // leva o corretor escolhido no painel
    document.getElementById('fcSoAcao').checked = !!op.soAcao;
    const busca = document.getElementById('fcBusca');
    busca.value = op.busca || '';
    document.getElementById('fcBuscaLimpar').hidden = !busca.value;
    aoAbrirFunil = op.coluna ? { coluna: op.coluna } : (op.busca ? { achado: true } : null);
    navigateTo('funil_consorcio');
  }

  function aplicarAoAbrir() {
    const pendente = aoAbrirFunil;
    aoAbrirFunil = null;
    if (!pendente) return;
    const board = document.getElementById('fcBoard');
    const achado = board.querySelector('.fc-achado');
    const alvo = pendente.coluna ? board.querySelector(`[data-col="${pendente.coluna}"]`) : (achado && achado.closest('.kanban-col'));
    rolarBoardPara(alvo);
  }

  function cartao(l, a, col, achado) {
    const dias = a ? a.dias_na_etapa : diasNaEtapa(l);
    const atraso = a && a.dias_de_atraso > 0;
    const zap = linkWhats(l.telefone);
    const chips = [l.bem_consorcio && esc(l.bem_consorcio), l.credito_desejado && 'crédito ' + brl(l.credito_desejado), l.parcela_desejada && 'parcela ' + brl(l.parcela_desejada), l.entrada_disponivel && 'entrada ' + brl(l.entrada_disponivel), l.origem && esc(l.origem)]
      .filter(Boolean).map((c) => `<span class="fc-chip">${c}</span>`).join('');
    const opcoes = ETAPAS.slice();
    if (!ROTULO[l.status] || l.status === 'perdido_definitivo' || String(l.status).startsWith('visita_')) opcoes.unshift([l.status, ROTULO[l.status] || String(l.status).replace(/_/g, ' ')]);
    return `
      <div class="kanban-card ${achado ? 'fc-achado' : ''}">
        <div class="fc-card-nome"><strong>${esc(l.nome)}</strong>${zap ? `<a class="fc-zap" href="${zap}" target="_blank" rel="noopener" title="Chamar no WhatsApp">WhatsApp</a>` : ''}</div>
        <small>${esc(l.telefone || 'sem telefone')}</small>
        ${col.st.length > 1 ? `<span class="fc-etapa">${esc(ROTULO[l.status] || l.status)}</span>` : ''}
        <div>${chips}</div>
        ${l.status === 'acompanhar_depois' ? blocoAcompanhar(l) : `<span class="fc-tempo ${atraso ? 'fc-vencido' : ''}">⏱ ${dias === 0 ? 'entrou hoje nesta etapa' : plural(dias, 'dia', 'dias') + ' nesta etapa'}</span>`}
        ${a ? `<div class="fc-acao">⏰ ${esc(a.titulo)}${atraso ? ' (atrasado ' + plural(a.dias_de_atraso, 'dia', 'dias') + ')' : ''}</div>` : ''}
        ${gestao() ? `<span class="kanban-card-corretor">${esc(l.usuarios?.nome || 'Sem corretor')}</span>` : ''}
        ${blocoCota(l)}
        <select class="status-select fc-mover" data-fc="mover" data-id="${esc(l.id)}">
          ${opcoes.map(([v, t]) => `<option value="${esc(v)}" ${v === l.status ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </div>`;
  }

  // quem já assinou (Assinaturas ou Pós-venda) ganha o botão para registrar a cota: valor, vencimento e lembrete do boleto
  function blocoCota(l) {
    if (!(l.status === 'assinaturas' || String(l.status).startsWith('pos_venda_'))) return '';
    return cotasPorLead.has(l.id)
      ? '<span class="fc-chip">💳 Cota registrada</span>'
      : `<button type="button" class="btn btn-ghost btn-sm" data-fc="cota-nova" data-lead="${esc(l.id)}">💳 Registrar cota</button>`;
  }

  function blocoAcompanhar(l) {
    const d = l.retomar_em ? diasAte(l.retomar_em) : null;
    const vencida = d !== null && d <= 0;
    const quando = d === null ? 'sem data' : d > 0 ? 'daqui a ' + plural(d, 'dia', 'dias') : d === 0 ? 'hoje' : 'atrasado ' + plural(-d, 'dia', 'dias');
    return `<span class="fc-tempo ${vencida ? 'fc-vencido' : ''}">📅 Retomar em ${esc(dataBR(l.retomar_em))} (${quando})</span>` +
      (l.motivo_acompanhar ? `<small>Motivo: ${esc(l.motivo_acompanhar)}</small>` : '') +
      (l.adiamentos > 0 ? `<small>Adiado ${plural(l.adiamentos, 'vez', 'vezes')}</small>` : '') +
      (l.adiamentos >= 3 ? '<div class="fc-aviso-decida">Já foi adiado 3 vezes: decida se fecha ou marca como perdido.</div>' : '') +
      `<button type="button" class="btn btn-ghost btn-sm" data-fc="adiar" data-id="${esc(l.id)}">Adiar retomada</button>`;
  }

  // ---- janelinha: quando retomar e por quê ----
  function fecharModal() { const m = document.getElementById('fcModal'); if (m) m.remove(); }

  function abrirModalAcompanhar(lead, modo) {
    fecharModal();
    const adiar = modo === 'adiar';
    const jaAdiou = adiar ? (lead.adiamentos || 0) : 0;
    const ov = document.createElement('div');
    ov.className = 'fc-modal';
    ov.id = 'fcModal';
    ov.dataset.id = lead.id;
    ov.dataset.modo = modo;
    ov.innerHTML = `
      <div class="fc-modal-box" role="dialog" aria-modal="true">
        <h3>${adiar ? 'Adiar retomada' : 'Acompanhar depois'}: ${esc(lead.nome)}</h3>
        <p class="fc-modal-sub">Quando vamos retomar o contato? Até essa data o CRM não cobra nada deste lead.</p>
        <div class="fc-rapido">${[7, 15, 30, 60, 90].map((n) => `<button type="button" data-fc-dias="${n}">${n} dias</button>`).join('')}</div>
        <label for="fcData">Retomar em</label>
        <input type="date" id="fcData" min="${hojeISO()}" value="${somaDias(30)}">
        <label for="fcMotivo">Motivo</label>
        <input type="text" id="fcMotivo" maxlength="140" list="fcMotivos" placeholder="Ex.: sem entrada agora" value="${esc(adiar ? (lead.motivo_acompanhar || '') : '')}">
        <datalist id="fcMotivos">
          <option value="Sem entrada agora"></option><option value="Esperando 13º, FGTS ou renda"></option><option value="Vai decidir em família"></option>
          <option value="Quer comparar com outra administradora"></option><option value="Pediu para ligar mais tarde"></option>
        </datalist>
        ${jaAdiou >= 2 ? `<p class="fc-modal-aviso">Este lead já foi adiado ${jaAdiou} vezes. Se adiar de novo, o CRM vai pedir que você decida: fechar ou marcar como perdido.</p>` : ''}
        <div class="fc-modal-acoes">
          <button type="button" class="btn btn-ghost btn-sm" data-fc="cancelar">Cancelar</button>
          <button type="button" class="btn btn-primary btn-sm" data-fc="salvar-acomp">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    setTimeout(() => { const el = document.getElementById(adiar ? 'fcData' : 'fcMotivo'); if (el) el.focus(); }, 30);
  }

  async function salvarAcompanhar() {
    const ov = document.getElementById('fcModal');
    if (!ov) return;
    const lead = leadsPorId.get(ov.dataset.id);
    const modo = ov.dataset.modo;
    const data = document.getElementById('fcData').value;
    const motivo = document.getElementById('fcMotivo').value.trim();
    if (!data) { aviso('Escolha a data para retomar.', true); return; }
    if (data < hojeISO()) { aviso('A data para retomar não pode estar no passado.', true); return; }
    if (modo === 'entrar' && motivo.length < 3) { aviso('Diga em poucas palavras o motivo.', true); return; }
    const payload = modo === 'entrar'
      ? { status: 'acompanhar_depois', retomar_em: data, motivo_acompanhar: motivo }
      : { retomar_em: data, motivo_acompanhar: motivo || (lead && lead.motivo_acompanhar) || null };
    const { error } = await supabase.from('leads').update(payload).eq('id', ov.dataset.id);
    if (error) { aviso('Não foi possível salvar.', true); console.error(error); return; }
    fecharModal();
    aviso(modo === 'entrar' ? 'Lead em acompanhamento. Retomada em ' + dataBR(data) + '.' : 'Retomada adiada para ' + dataBR(data) + '.');
    if (typeof loadDashboard === 'function') { try { loadDashboard(); } catch (e) { /* ignora */ } }
    carregarFunil();
  }

  async function moverLead(id, novoStatus) {
    const payload = { status: novoStatus };
    if (novoStatus === 'perdido') {
      const motivo = window.prompt('Motivo da perda (preço, foi para outra administradora, desistiu, sem resposta...):', '');
      if (motivo && motivo.trim()) payload.motivo_perda = motivo.trim();
    }
    const { error } = await supabase.from('leads').update(payload).eq('id', id);
    if (error) { aviso('Não foi possível mudar a etapa do lead.', true); console.error(error); return; }
    aviso('Etapa atualizada.');
    if (typeof loadDashboard === 'function') { try { loadDashboard(); } catch (e) { /* ignora */ } }
    carregarFunil();
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.fc === 'mover') {
      const lead = leadsPorId.get(t.dataset.id);
      if (t.value === 'acompanhar_depois' && lead && lead.status !== 'acompanhar_depois') { t.value = lead.status; abrirModalAcompanhar(lead, 'entrar'); }
      else moverLead(t.dataset.id, t.value);
    }
    if (t && t.id === 'fcFiltroCorretor') carregarFunil();
    if (t && t.id === 'ctEncerradas') carregarCotas();
    if (t && t.id === 'ctCorretor') desenharCotas();
    if (t && (t.id === 'fcSoAcao' || t.id === 'fcMostrarPerdidos')) desenharFunil(false);
    if (t && (t.id === 'pcPeriodo' || t.id === 'pcCorretor')) carregarPainel();
  });
  document.addEventListener('click', (e) => {
    const alvo = e.target && e.target.closest ? e.target.closest('[data-fc],[data-fc-dias]') : null;
    if (alvo && alvo.dataset.fcDias) { const d = document.getElementById('fcData'); if (d) d.value = somaDias(Number(alvo.dataset.fcDias)); }
    if (alvo && alvo.dataset.fc === 'adiar') { const lead = leadsPorId.get(alvo.dataset.id); if (lead) abrirModalAcompanhar(lead, 'adiar'); }
    if (alvo && alvo.dataset.fc === 'cancelar') fecharModal();
    if (alvo && alvo.dataset.fc === 'salvar-acomp') salvarAcompanhar();
    if (alvo && alvo.dataset.fc === 'cota-nova') abrirModalCota({ leadId: alvo.dataset.lead || '' });
    if (alvo && alvo.dataset.fc === 'cota-editar') { const c = cotasCache.find((x) => x.cota_id === alvo.dataset.id); if (c) abrirModalCota({ cota: c }); }
    if (alvo && alvo.dataset.fc === 'cota-encerrar') alterarAtiva(alvo.dataset.id, false);
    if (alvo && alvo.dataset.fc === 'cota-reativar') alterarAtiva(alvo.dataset.id, true);
    if (alvo && alvo.dataset.fc === 'cota-salvar') salvarCota();
    if (e.target && e.target.id === 'ctAtualizar') carregarCotas();
    if (e.target && e.target.id === 'fcModal') fecharModal();
    const cartaoIr = e.target && e.target.closest ? e.target.closest('[data-fc-ir]') : null;
    if (cartaoIr) acionarCartao(cartaoIr.dataset.fcIr);
    const abrirLead = e.target && e.target.closest ? e.target.closest('[data-fc-abrir]') : null;
    if (abrirLead) abrirFunil({ busca: abrirLead.dataset.fcAbrir });
    if (e.target && e.target.id === 'fcBuscaLimpar') limparBusca();
    if (e.target && e.target.id === 'fcAtualizar') carregarFunil();
    if (e.target && e.target.id === 'pcAtualizar') carregarPainel();
  });

  function acionarCartao(destino) {
    if (destino === 'acao') abrirFunil({ soAcao: true });
    else if (destino === 'acompanhar') abrirFunil({ coluna: 'acompanhar' });
    else if (destino === 'adesao') abrirFunil({ coluna: 'assinaturas' });
    else abrirFunil({});
  }
  // cartão do painel também abre com Enter ou Espaço (acessível pelo teclado)
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('[data-fc-ir]')) {
      e.preventDefault();
      acionarCartao(e.target.dataset.fcIr);
    }
  });

  let esperaBusca;
  function atualizarBusca() {
    const el = document.getElementById('fcBusca');
    const limpar = document.getElementById('fcBuscaLimpar');
    if (limpar) limpar.hidden = !(el && el.value);
    desenharFunil(true);
  }
  function limparBusca() {
    const el = document.getElementById('fcBusca');
    if (el) { el.value = ''; el.focus(); }
    atualizarBusca();
  }
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'fcBusca') {
      const limpar = document.getElementById('fcBuscaLimpar');
      if (limpar) limpar.hidden = !e.target.value;
      clearTimeout(esperaBusca);
      esperaBusca = setTimeout(() => desenharFunil(true), 150);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const el = document.getElementById('fcBusca');
    if (document.activeElement === el && el.value && !document.getElementById('fcModal')) limparBusca();
    else fecharModal();
  });

  // =====================================================================
  // 2) PAINEL
  // =====================================================================
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  const linhaFunil = (rotulo, valor, total, verde) =>
    `<div class="fc-barra-linha"><span>${esc(rotulo)}</span><div class="fc-trilho"><div class="fc-barra ${verde ? 'fc-verde' : ''}" style="width:${total ? Math.max(valor / total * 100, valor ? 2 : 0) : 0}%"></div></div><span class="fc-num"><b>${valor}</b> · ${pct(valor, total)}</span></div>`;

  // o número grande do cartão nunca pode quebrar em duas linhas nem passar da borda: a letra diminui até caber
  function ajustarValoresDoPainel() {
    document.querySelectorAll('#pcConteudo .stat-value').forEach((el) => {
      el.style.fontSize = '';
      let tamanho = parseFloat(getComputedStyle(el).fontSize);
      while (el.scrollWidth > el.clientWidth + 1 && tamanho > 13) { tamanho -= 1; el.style.fontSize = tamanho + 'px'; }
    });
  }
  let esperaAjuste;
  window.addEventListener('resize', () => {
    clearTimeout(esperaAjuste);
    esperaAjuste = setTimeout(() => { const v = document.getElementById('view-painel_consorcio'); if (v && !v.hidden) ajustarValoresDoPainel(); }, 120);
  });

  async function carregarPainel() {
    const box = document.getElementById('pcConteudo');
    box.innerHTML = '<p class="table-empty">Carregando…</p>';
    await carregarCorretores('pcCorretor');
    const dias = Number(document.getElementById('pcPeriodo').value) || 30;
    const corretor = gestao() ? (document.getElementById('pcCorretor').value || null) : null;
    const { data, error } = await supabase.rpc('consorcio_painel', { p_dias: dias, p_corretor: corretor });
    if (error || !data) { box.innerHTML = '<p class="table-empty">Erro ao carregar o painel.</p>'; console.error(error); return; }
    const p = data;
    const f = p.funil || {};
    const etapa = p.por_etapa || {};
    const tempo = p.tempo_primeiro_contato_horas;
    const tempoTxt = tempo === null || tempo === undefined ? '—' : (Number(tempo) < 1 ? 'menos de 1 h' : Number(tempo).toLocaleString('pt-BR') + ' h');
    const inicioPeriodo = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    const notaHistorico = !p.historico_desde || p.historico_desde > inicioPeriodo
      ? `<p class="fc-nota">O histórico de mudanças de etapa começa em ${p.historico_desde ? new Date(p.historico_desde + 'T00:00:00').toLocaleDateString('pt-BR') : 'hoje (ainda sem mudanças)'}. Antes disso, o funil usa só a etapa em que cada lead está agora, então os números do início podem ficar abaixo do real.</p>` : '';

    // valor grande não pode quebrar em duas linhas: de 1 milhão para cima mostra "R$ 1,2 mi"
    const brlCurto = (v) => { const n = Number(v) || 0; return n >= 1e6 ? 'R$ ' + (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' mi' : (brl(n) || 'R$ 0'); };
    // cartão clicável: leva ao funil (destino) e mostra uma frase curta dizendo o que acontece ao clicar (dica)
    const stat = (valor, rotulo, classe, destino, dica, dicaOk, titulo) =>
      `<div class="stat-card ${classe || ''} ${destino ? 'fc-clicavel' : ''}" ${destino ? `role="button" tabindex="0" data-fc-ir="${destino}"` : ''} ${titulo ? `title="${esc(titulo)}"` : ''}>` +
      `<div class="stat-value">${valor}</div><div class="stat-label">${rotulo}</div>${dica ? `<div class="fc-card-dica ${dicaOk ? 'fc-ok' : ''}">${dica}</div>` : ''}</div>`;
    const chaveBusca = (nome, tel) => { const d = String(tel || '').replace(/\D/g, ''); return d.length >= 3 ? d : (nome || ''); };
    const ordemEtapas = ETAPAS.map((e) => e[0]).concat(['perdido_definitivo', 'visita_agendada', 'visita_feita']);
    const linhasEtapa = ordemEtapas.filter((s) => etapa[s]).map((s) => `<tr><td>${esc(ROTULO[s] || String(s).replace(/_/g, ' '))}</td><td class="fc-r">${etapa[s]}</td></tr>`).join('');
    const linhasOrigem = (p.por_origem || []).map((o) => `<tr><td>${esc(o.origem)}</td><td class="fc-r">${o.qtd}</td></tr>`).join('');
    const linhasCorretor = (p.por_corretor || []).map((c) => `<tr><td class="fc-nome" title="${esc(c.corretor)}">${esc(c.corretor)}</td><td class="fc-r">${c.novos}</td><td class="fc-r">${c.em_andamento}</td><td class="fc-r">${c.adesoes}</td></tr>`).join('');
    const linhasRetomada = (p.proximas_retomadas || []).map((r) => `<tr><td class="fc-nome" title="${esc(r.nome)}"><button type="button" class="fc-link" data-fc-abrir="${esc(chaveBusca(r.nome, r.telefone))}">${esc(r.nome)}</button></td><td class="${r.vencida ? 'fc-vencido' : ''}" style="white-space:nowrap;">${esc(dataBR(r.retomar_em))}${r.vencida ? ' ⚠' : ''}</td><td class="fc-nome" title="${esc(r.motivo || '')}">${esc(r.motivo || '—')}</td></tr>`).join('');
    const motivos = ((p.perdidos || {}).motivos || []).map((m) => `<tr><td>${esc(m.motivo)}</td><td class="fc-r">${m.qtd}</td></tr>`).join('');

    // "O que fazer agora": quem, o que fazer e há quanto tempo está parado
    const acoes = p.acoes || [];
    const itensFazer = acoes.map((a) => {
      const instrucao = String(a.titulo || '').replace(/^Consórcio:\s*/i, '');
      const atraso = Number(a.dias_de_atraso) || 0;
      const quando = atraso > 0 ? `<span class="fc-vencido">atrasado ${plural(atraso, 'dia', 'dias')}</span>` : '<span>para hoje</span>';
      const zap = linkWhats(a.telefone);
      return `<div class="fc-fazer-item">
        <div>
          <div class="fc-fazer-nome">${esc(a.nome)}</div>
          <div class="fc-fazer-texto">${esc(instrucao)}</div>
          <div class="fc-fazer-meta"><span class="fc-chip">${esc(ROTULO[a.status] || String(a.status).replace(/_/g, ' '))}</span>${quando}${gestao() ? `<span>· ${esc(a.corretor)}</span>` : ''}</div>
        </div>
        <div class="fc-fazer-botoes">
          <button type="button" class="btn btn-primary btn-sm" data-fc-abrir="${esc(chaveBusca(a.nome, a.telefone))}">Abrir no funil</button>
          ${zap ? `<a class="btn btn-ghost btn-sm" href="${zap}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        </div>
      </div>`;
    }).join('');
    const painelFazer = `<div class="panel" id="pcFazer">
        <div class="panel-head"><h2>O que fazer agora</h2></div>
        ${itensFazer || '<p class="table-empty">Nada pendente agora. Bom trabalho!</p>'}
        ${(p.acoes_atrasadas || 0) > acoes.length ? `<p class="fc-nota">Mostrando os ${acoes.length} mais atrasados de ${p.acoes_atrasadas}.</p>` : ''}
      </div>`;

    box.innerHTML = `
      <div class="fc-grade">
        ${stat(p.novos_no_periodo, 'Leads novos no período', '', 'todos', 'Ver no funil →')}
        ${stat(p.em_andamento, 'Em andamento agora', '', 'todos', 'Ver no funil →')}
        ${stat(p.em_acompanhamento || 0, 'Em acompanhamento (retomada combinada)', '', p.em_acompanhamento ? 'acompanhar' : '', 'Ver as retomadas →')}
        ${stat(p.acoes_atrasadas, 'Pedem ação agora', p.acoes_atrasadas ? 'stat-danger' : '', p.acoes_atrasadas ? 'acao' : '', p.acoes_atrasadas ? 'Ver quem e o que fazer →' : 'Nada pendente agora', !p.acoes_atrasadas)}
        ${stat(f.adesao || 0, 'Adesões (leads do período)', 'stat-success', f.adesao ? 'adesao' : '', 'Ver no funil →')}
        ${stat(brlCurto(p.credito_em_andamento), 'Crédito desejado em andamento', '', 'todos', 'Ver no funil →', false, brl(p.credito_em_andamento))}
        ${stat(tempoTxt, 'Tempo até o 1º contato (mediana)')}
      </div>
      ${painelFazer}
      ${notaHistorico}
      <div class="panel">
        <div class="panel-head"><h2>Funil dos leads que chegaram no período</h2></div>
        ${linhaFunil('Leads', f.leads || 0, f.leads || 0)}
        ${linhaFunil('Em contato', f.contato || 0, f.leads || 0)}
        ${linhaFunil('Qualificados', f.qualificado || 0, f.leads || 0)}
        ${linhaFunil('Simulação enviada', f.simulacao || 0, f.leads || 0)}
        ${linhaFunil('Proposta', f.proposta || 0, f.leads || 0)}
        ${linhaFunil('Adesão', f.adesao || 0, f.leads || 0, true)}
        <p class="fc-nota" style="margin-top:10px;">A porcentagem é sobre o total de leads do período. Onde a barra cai de uma linha para a outra é onde o funil está vazando.</p>
      </div>
      <div class="fc-duas">
        <div class="panel"><div class="panel-head"><h2>Situação atual (todos os leads)</h2></div>
          ${linhasEtapa ? `<table class="fc-tab"><tbody>${linhasEtapa}</tbody></table>` : '<p class="table-empty">Sem leads de consórcio.</p>'}</div>
        <div class="panel"><div class="panel-head"><h2>De onde vieram (período)</h2></div>
          ${linhasOrigem ? `<table class="fc-tab"><tbody>${linhasOrigem}</tbody></table>` : '<p class="table-empty">Sem leads no período.</p>'}</div>
        <div class="panel"><div class="panel-head"><h2>Por corretor</h2></div>
          ${linhasCorretor ? `<table class="fc-tab"><thead><tr><th>Corretor</th><th class="fc-r">Novos</th><th class="fc-r" title="Em andamento">Ativos</th><th class="fc-r">Adesões</th></tr></thead><tbody>${linhasCorretor}</tbody></table>` : '<p class="table-empty">Sem dados.</p>'}</div>
        <div class="panel"><div class="panel-head"><h2>Próximas retomadas</h2></div>
          ${linhasRetomada ? `<table class="fc-tab"><thead><tr><th>Lead</th><th>Retomar em</th><th>Motivo</th></tr></thead><tbody>${linhasRetomada}</tbody></table>` : '<p class="table-empty">Nenhum lead em acompanhamento.</p>'}</div>
        <div class="panel"><div class="panel-head"><h2>Perdidos no período: ${(p.perdidos || {}).total || 0}</h2></div>
          ${motivos ? `<table class="fc-tab"><thead><tr><th>Motivo</th><th class="fc-r">Qtd.</th></tr></thead><tbody>${motivos}</tbody></table>` : '<p class="table-empty">Nenhum lead perdido no período.</p>'}</div>
      </div>`;
    ajustarValoresDoPainel();
  }

  // =====================================================================
  // 3) COTAS FECHADAS: valor, vencimento e lembrete do boleto
  // O CRM cria, todo dia de manhã, a tarefa "enviar o boleto" 1 dia antes do vencimento (a regra fica no banco).
  // =====================================================================
  let cotasCache = [];
  let leadsParaCota = new Map();
  const BENS = ['Imóvel', 'Terreno', 'Veículo', 'Construção ou reforma', 'Carta contemplada', 'Investimento', 'Outro'];
  const brl2 = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const chaveDeBusca = (nome, tel) => { const d = String(tel || '').replace(/\D/g, ''); return d.length >= 3 ? d : (nome || ''); };
  const dataCurta = (iso) => { const [, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}`; };
  const quandoVence = (d) => d === 0 ? 'hoje' : d === 1 ? 'amanhã' : 'em ' + plural(d, 'dia', 'dias');
  const SITUACAO = {
    enviar_boleto: ['fc-sit-enviar', 'Enviar o boleto agora'],
    aguardando: ['fc-sit-esp', 'Aguardando'],
    boleto_enviado: ['fc-sit-ok', 'Boleto enviado'],
    encerrada: ['fc-sit-fim', 'Encerrada'],
  };

  // aceita "80.000,00", "80000", "210.96" e "210,96"
  function lerNumero(texto) {
    let t = String(texto == null ? '' : texto).trim().replace(/[^\d.,]/g, '');
    if (!t) return null;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    const n = Number(t);
    return isNaN(n) ? null : n;
  }

  async function carregarCotas() {
    const box = document.getElementById('ctLista');
    box.innerHTML = '<p class="table-empty">Carregando…</p>';
    await carregarCorretores('ctCorretor');
    const incluir = document.getElementById('ctEncerradas').checked;
    const { data, error } = await supabase.rpc('consorcio_cotas_lista_v2', { p_incluir_encerradas: incluir });
    if (error) { box.innerHTML = '<p class="table-empty">Erro ao carregar as cotas.</p>'; console.error(error); return; }
    cotasCache = data || [];
    desenharCotas();
  }

  function desenharCotas() {
    const box = document.getElementById('ctLista');
    const sel = document.getElementById('ctCorretor');
    const nomeCorretor = gestao() && sel && sel.value ? (sel.options[sel.selectedIndex].textContent || '') : '';
    const lista = cotasCache.filter((c) => !nomeCorretor || c.corretor === nomeCorretor);
    const ativas = lista.filter((c) => c.ativa);
    const somaCartas = ativas.reduce((a, c) => a + (Number(c.credito) || 0), 0);
    const somaParcelas = ativas.reduce((a, c) => a + (Number(c.parcela_valor) || 0), 0);
    const aEnviar = ativas.filter((c) => c.situacao_boleto === 'enviar_boleto').length;
    const somaComissaoTotal = ativas.reduce((a, c) => a + (Number(c.comissao_valor_total) || 0), 0);
    const somaComissaoAReceber = ativas.reduce((a, c) => a + (Number(c.comissao_valor_a_receber) || 0), 0);
    const emRisco = ativas.filter((c) => c.comissao_em_risco_estorno).length;
    document.getElementById('ctResumo').innerHTML =
      `<span class="fc-pilula">Cotas ativas: <b>${ativas.length}</b></span>` +
      `<span class="fc-pilula">Soma das cartas: <b>${esc(brl2(somaCartas) || 'R$ 0,00')}</b></span>` +
      `<span class="fc-pilula">Parcelas por mês: <b>${esc(brl2(somaParcelas) || 'R$ 0,00')}</b></span>` +
      `<span class="fc-pilula ${aEnviar ? 'fc-alerta' : ''}">Boletos a enviar: <b>${aEnviar}</b></span>` +
      `<span class="fc-pilula">Comissão total: <b>${esc(brl2(somaComissaoTotal) || 'R$ 0,00')}</b></span>` +
      `<span class="fc-pilula">Comissão a receber: <b>${esc(brl2(somaComissaoAReceber) || 'R$ 0,00')}</b></span>` +
      `<span class="fc-pilula ${emRisco ? 'fc-alerta' : ''}" title="Cliente ainda não pagou as 4 primeiras parcelas dentro de 12 meses — contrato Axton permite estorno da comissão">Em risco de estorno: <b>${emRisco}</b></span>`;
    if (!lista.length) {
      box.innerHTML = '<p class="table-empty">Nenhuma cota registrada ainda. Use “+ Registrar cota” ou o botão “Registrar cota” no card do cliente que assinou, no Funil de Consórcio.</p>';
      return;
    }
    box.innerHTML = lista.map((c) => {
      const [classe, rotulo] = SITUACAO[c.situacao_boleto] || ['fc-sit-esp', String(c.situacao_boleto)];
      const zap = linkWhats(c.telefone);
      const conferir = /^PRÉ-PREENCHIDO/i.test(c.observacoes || '');
      const ident = [c.administradora, c.grupo && 'grupo ' + c.grupo, c.cota && 'cota ' + c.cota, c.bem].filter(Boolean).join(' · ');
      const proximo = c.ativa
        ? `<span>Próximo vencimento: <b>${esc(dataCurta(c.proximo_vencimento))}</b> (${quandoVence(c.dias_para_vencer)})</span><span>· lembrete do boleto: ${esc(dataCurta(c.dia_do_lembrete))}</span>` : '';
      return `<div class="fc-cota ${c.ativa ? '' : 'fc-cota-fim'}">
        <div>
          <div class="fc-fazer-nome">${esc(c.nome)} ${conferir ? '<span class="fc-chip" title="Dados pré-preenchidos: confira com o contrato e edite a cota">⚠ conferir dados</span>' : ''}</div>
          <div class="fc-fazer-texto">${esc(ident)}</div>
          <div class="fc-fazer-texto"><b>Carta ${esc(brl2(c.credito))}</b> · ${c.parcela_valor ? 'parcela ' + esc(brl2(c.parcela_valor)) : 'parcela não informada'} · vence todo dia ${esc(c.vencimento_dia)}</div>
          <div class="fc-fazer-texto">Comissão ${esc(c.parceiro_comissao || 'Axton')} ${esc(c.comissao_percentual)}%: <b>${esc(brl2(c.comissao_valor_total))}</b> (${esc(c.comissao_parcelas_recebidas)}/${esc(c.comissao_parcelas)} parcelas recebidas, ${esc(brl2(c.comissao_valor_a_receber))} a receber)${c.comissao_em_risco_estorno ? ' <span class="fc-chip" title="Cliente ainda não pagou as 4 primeiras parcelas da carta dentro de 12 meses — risco de estorno pelo contrato Axton">⚠ risco de estorno</span>' : ''}</div>
          <div class="fc-fazer-meta">${proximo}${gestao() ? `<span>· ${esc(c.corretor || 'Sem corretor')}</span>` : ''}</div>
          ${c.observacoes ? `<div class="fc-nota" style="margin:6px 0 0;">${esc(c.observacoes)}</div>` : ''}
        </div>
        <div class="fc-cota-lado">
          <span class="fc-sit ${classe}">${esc(rotulo)}${c.situacao_boleto === 'aguardando' ? ' (' + esc(dataCurta(c.dia_do_lembrete)) + ')' : ''}</span>
          <div class="fc-fazer-botoes">
            <button type="button" class="btn btn-primary btn-sm" data-fc="cota-editar" data-id="${esc(c.cota_id)}">Editar</button>
            <button type="button" class="btn btn-ghost btn-sm" data-fc-abrir="${esc(chaveDeBusca(c.nome, c.telefone))}">Abrir no funil</button>
            ${zap ? `<a class="btn btn-ghost btn-sm" href="${zap}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
            ${c.ativa ? `<button type="button" class="btn btn-ghost btn-sm" data-fc="cota-encerrar" data-id="${esc(c.cota_id)}">Encerrar</button>`
                      : `<button type="button" class="btn btn-ghost btn-sm" data-fc="cota-reativar" data-id="${esc(c.cota_id)}">Reativar</button>`}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ---- janelinha: registrar ou editar a cota ----
  async function abrirModalCota(opcoes) {
    opcoes = opcoes || {};
    fecharModal();
    const cota = opcoes.cota || null;
    const { data } = await supabase.from('leads').select('id,nome,status,credito_desejado,parcela_desejada,bem_consorcio').in('interesse', INTERESSES).not('status', 'in', '(perdido,perdido_definitivo)').order('nome').limit(1000);
    const peso = (st) => (st === 'assinaturas' || String(st).startsWith('pos_venda_')) ? 0 : 1;     // quem já assinou aparece primeiro
    const leads = (data || []).slice().sort((a, b) => peso(a.status) - peso(b.status) || String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    leadsParaCota = new Map(leads.map((l) => [l.id, l]));
    const leadId = cota ? cota.lead_id : (opcoes.leadId || '');
    const travado = !!leadId;
    const lead0 = leadsParaCota.get(leadId);
    const v = (x) => esc(x == null ? '' : x);
    const numTxt = (n) => (n == null || n === '') ? '' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bem0 = cota ? cota.bem : (lead0 && BENS.includes(lead0.bem_consorcio) ? lead0.bem_consorcio : 'Imóvel');
    const credito0 = cota ? cota.credito : (lead0 ? lead0.credito_desejado : '');
    const parcela0 = cota ? cota.parcela_valor : '';
    const preenchido = !!(cota && /^PRÉ-PREENCHIDO/i.test(cota.observacoes || ''));
    const ov = document.createElement('div');
    ov.className = 'fc-modal';
    ov.id = 'fcModal';
    ov.dataset.modo = 'cota';
    ov.dataset.id = cota ? cota.cota_id : '';
    ov.innerHTML = `
      <div class="fc-modal-box fc-modal-grande" role="dialog" aria-modal="true">
        <h3>${cota ? 'Editar cota' : 'Registrar cota fechada'}</h3>
        <p class="fc-modal-sub">O CRM avisa o corretor para enviar o boleto antes do vencimento.</p>
        <label for="ctLead">Cliente</label>
        <select id="ctLead" ${travado ? 'disabled' : ''}>
          ${travado ? '' : '<option value="">Escolha o cliente</option>'}
          ${leads.map((l) => `<option value="${esc(l.id)}" ${l.id === leadId ? 'selected' : ''}>${esc(l.nome)} (${esc(ROTULO[l.status] || l.status)})</option>`).join('')}
        </select>
        <div class="fc-form-grid">
          <div><label for="ctAdm">Administradora</label><input type="text" id="ctAdm" value="${v(cota ? cota.administradora : 'Servopa')}"></div>
          <div><label for="ctBem">Bem</label><select id="ctBem">${BENS.map((b) => `<option ${b === bem0 ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
          <div><label for="ctGrupo">Grupo</label><input type="text" id="ctGrupo" value="${v(cota && cota.grupo)}"></div>
          <div><label for="ctCotaNum">Nº da cota</label><input type="text" id="ctCotaNum" value="${v(cota && cota.cota)}"></div>
          <div><label for="ctCredito">Valor da carta (R$)</label><input type="text" inputmode="decimal" id="ctCredito" placeholder="80.000,00" value="${v(numTxt(credito0))}"></div>
          <div><label for="ctParcela">Valor da parcela (R$)</label><input type="text" inputmode="decimal" id="ctParcela" placeholder="210,96" value="${v(numTxt(parcela0))}"></div>
          <div><label for="ctVenc">Dia do vencimento (1 a 31)</label><input type="number" id="ctVenc" min="1" max="31" value="${v(cota && cota.vencimento_dia)}"></div>
          <div><label for="ctDias">Lembrar quantos dias antes</label><input type="number" id="ctDias" min="0" max="15" value="${v(cota ? cota.lembrar_dias_antes : 1)}"></div>
          <div><label for="ctAdesao">Data da assinatura</label><input type="date" id="ctAdesao" value="${v(cota && cota.data_adesao)}"></div>
        </div>
        <h4 class="fc-modal-sub" style="margin:14px 0 6px;">Comissão (conforme contrato com o parceiro)</h4>
        <div class="fc-form-grid">
          <div><label for="ctParceiro">Parceiro que paga</label><input type="text" id="ctParceiro" value="${v(cota ? cota.parceiro_comissao : 'Axton')}"></div>
          <div><label for="ctComissaoPct">Comissão (%)</label><input type="text" inputmode="decimal" id="ctComissaoPct" value="${v(numTxt(cota ? cota.comissao_percentual : 2.5))}"></div>
          <div><label for="ctComissaoParcelas">Pago em quantas parcelas</label><input type="number" id="ctComissaoParcelas" min="1" max="24" value="${v(cota ? cota.comissao_parcelas : 6)}"></div>
          <div><label for="ctComissaoRecebidas">Parcelas da comissão já recebidas</label><input type="number" id="ctComissaoRecebidas" min="0" max="24" value="${v(cota ? cota.comissao_parcelas_recebidas : 0)}"></div>
          <div><label for="ctParcelasCliente">Parcelas da carta já pagas pelo cliente</label><input type="number" id="ctParcelasCliente" min="0" value="${v(cota ? cota.parcelas_cliente_pagas : 0)}"></div>
        </div>
        <p class="fc-modal-sub" style="margin:4px 0 0;">Se o cliente não pagar as 4 primeiras parcelas da carta em até 12 meses, o parceiro pode estornar a comissão — mantenha "parcelas já pagas pelo cliente" atualizado pra acompanhar esse risco.</p>
        <label for="ctObs">Observações</label>
        <input type="text" id="ctObs" maxlength="300" value="${v(cota && cota.observacoes)}">
        ${preenchido ? '<label class="fc-conferido"><input type="checkbox" id="ctConferido"> Conferi os dados com o contrato (tira o aviso “conferir dados”)</label>' : ''}
        <div class="fc-modal-acoes">
          <button type="button" class="btn btn-ghost btn-sm" data-fc="cancelar">Cancelar</button>
          <button type="button" class="btn btn-primary btn-sm" data-fc="cota-salvar">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    setTimeout(() => { const el = document.getElementById(travado ? 'ctCredito' : 'ctLead'); if (el) el.focus(); }, 30);
  }

  async function salvarCota() {
    const ov = document.getElementById('fcModal');
    if (!ov || ov.dataset.modo !== 'cota') return;
    const id = ov.dataset.id;
    const leadId = document.getElementById('ctLead').value;
    const credito = lerNumero(document.getElementById('ctCredito').value);
    const parcelaTxt = document.getElementById('ctParcela').value.trim();
    const parcela = parcelaTxt ? lerNumero(parcelaTxt) : null;
    const venc = parseInt(document.getElementById('ctVenc').value, 10);
    const diasTxt = document.getElementById('ctDias').value;
    const dias = diasTxt === '' ? 1 : parseInt(diasTxt, 10);
    if (!leadId) { aviso('Escolha o cliente.', true); return; }
    if (!credito || credito <= 0) { aviso('Informe o valor da carta.', true); return; }
    if (parcelaTxt && (!parcela || parcela <= 0)) { aviso('O valor da parcela não é válido.', true); return; }
    if (!venc || venc < 1 || venc > 31) { aviso('Informe o dia do vencimento, de 1 a 31.', true); return; }
    if (isNaN(dias) || dias < 0 || dias > 15) { aviso('Lembrar antes: de 0 a 15 dias.', true); return; }
    const comissaoPct = lerNumero(document.getElementById('ctComissaoPct').value) || 0;
    const comissaoParcelas = parseInt(document.getElementById('ctComissaoParcelas').value, 10);
    const comissaoRecebidas = parseInt(document.getElementById('ctComissaoRecebidas').value, 10) || 0;
    const parcelasCliente = parseInt(document.getElementById('ctParcelasCliente').value, 10) || 0;
    if (!comissaoParcelas || comissaoParcelas < 1) { aviso('Informe em quantas parcelas a comissão é paga.', true); return; }
    if (comissaoRecebidas > comissaoParcelas) { aviso('Parcelas da comissão recebidas não pode ser maior que o total de parcelas.', true); return; }
    const conf = document.getElementById('ctConferido');
    const obs = conf && conf.checked ? 'Dados conferidos com o contrato em ' + dataBR(hojeISO()) + '.' : document.getElementById('ctObs').value.trim();
    const payload = {
      administradora: document.getElementById('ctAdm').value.trim() || 'Servopa',
      grupo: document.getElementById('ctGrupo').value.trim() || null,
      cota: document.getElementById('ctCotaNum').value.trim() || null,
      bem: document.getElementById('ctBem').value || null,
      credito, parcela_valor: parcela, vencimento_dia: venc, lembrar_dias_antes: dias,
      data_adesao: document.getElementById('ctAdesao').value || null,
      observacoes: obs || null,
      parceiro_comissao: document.getElementById('ctParceiro').value.trim() || 'Axton',
      comissao_percentual: comissaoPct,
      comissao_parcelas: comissaoParcelas,
      comissao_parcelas_recebidas: comissaoRecebidas,
      parcelas_cliente_pagas: parcelasCliente,
    };
    if (!id) payload.lead_id = leadId;
    const { error } = id ? await supabase.from('consorcio_cotas').update(payload).eq('id', id) : await supabase.from('consorcio_cotas').insert(payload);
    if (error) { aviso('Não foi possível salvar a cota.', true); console.error(error); return; }
    fecharModal();
    aviso(id ? 'Cota atualizada.' : 'Cota registrada. O CRM vai lembrar do boleto ' + plural(dias, 'dia', 'dias') + ' antes do vencimento.');
    const visivel = (idv) => { const el = document.getElementById('view-' + idv); return el && !el.hidden; };
    if (visivel('cotas_consorcio')) carregarCotas();
    if (visivel('funil_consorcio')) carregarFunil();
  }

  async function alterarAtiva(id, ativa) {
    const c = cotasCache.find((x) => x.cota_id === id);
    if (!ativa && !window.confirm('Encerrar a cota de ' + (c ? c.nome : 'este cliente') + '? O CRM deixa de lembrar do boleto.')) return;
    const { error } = await supabase.from('consorcio_cotas').update({ ativa }).eq('id', id);
    if (error) { aviso('Não foi possível alterar a cota.', true); console.error(error); return; }
    aviso(ativa ? 'Cota reativada.' : 'Cota encerrada.');
    carregarCotas();
  }

  // ao escolher o cliente, sugere carta e bem do que já está no lead (só se os campos estiverem vazios)
  document.addEventListener('change', (e) => {
    if (!(e.target && e.target.id === 'ctLead')) return;
    const l = leadsParaCota.get(e.target.value);
    const cred = document.getElementById('ctCredito');
    if (l && cred && !cred.value && l.credito_desejado) cred.value = Number(l.credito_desejado).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bem = document.getElementById('ctBem');
    if (l && bem && BENS.includes(l.bem_consorcio)) bem.value = l.bem_consorcio;
  });

  window.FunilConsorcio = { carregarFunil, carregarPainel, carregarCotas };
})();
