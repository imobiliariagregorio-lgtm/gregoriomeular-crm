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
    ['pos_venda_120', 'Pós-venda 120 dias'], ['perdido', 'Perdido'],
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

  // ---------- estilo (usa as variáveis de cor do CRM) ----------
  const css = `
    .filters-bar-label input[type=checkbox]{padding:0;width:auto;}
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
    .fc-grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:16px;}
    .fc-duas{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-top:14px;}
    .fc-duas .panel{overflow-x:auto;}
    .fc-grade .stat-value{font-size:1.55rem;overflow-wrap:anywhere;}
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

  function criarMenu() {
    const painel = qs('.topnav-dropdown[data-group-panel="vendas"]');
    if (!painel) { console.warn('[funil-consorcio] menu "Vendas" não encontrado.'); return; }
    // os dois itens entram logo depois do "Funil de Vendas" (ou no começo do menu, se ele não existir)
    let ancora = qs('.nav-item[data-view="funil"]', painel);
    [['funil_consorcio', '🏦 Funil de Consórcio'], ['painel_consorcio', '📊 Painel de Consórcio']].forEach(([view, texto]) => {
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
    const minhaTela = view === 'funil_consorcio' || view === 'painel_consorcio';
    let falhou = null;
    try { navegarOriginal(view); } catch (e) { falhou = e; }
    // mesmo que o navigateTo original falhe, a tela certa aparece e as outras somem
    document.querySelectorAll('.view').forEach((sec) => { sec.hidden = sec.id !== 'view-' + view; });
    if (falhou) { if (!minhaTela) throw falhou; console.error(falhou); }
    if (view === 'funil_consorcio') carregarFunil();
    if (view === 'painel_consorcio') carregarPainel();
  };

  // =====================================================================
  // 1) QUADRO (KANBAN)
  // =====================================================================
  let corretoresCarregados = false;

  async function carregarCorretores(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.hidden = !gestao();
    if (!gestao() || sel.dataset.pronto) return;
    const { data } = await supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome');
    (data || []).forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.nome; sel.appendChild(o); });
    sel.dataset.pronto = '1';
  }

  async function carregarFunil() {
    const board = document.getElementById('fcBoard');
    board.innerHTML = '<p class="table-empty">Carregando…</p>';
    await carregarCorretores('fcFiltroCorretor');

    let q = supabase.from('leads').select('*, usuarios(id,nome)').in('interesse', INTERESSES).order('status_alterado_em', { ascending: true }).limit(1000);
    const corretor = document.getElementById('fcFiltroCorretor').value;
    if (gestao()) { if (corretor) q = q.eq('corretor_id', corretor); }
    else if (typeof currentUsuario !== 'undefined' && currentUsuario) q = q.eq('corretor_id', currentUsuario.id);

    const [resLeads, resAcao] = await Promise.all([q, supabase.rpc('consorcio_leads_com_acao')]);
    if (resLeads.error) { board.innerHTML = '<p class="table-empty">Erro ao carregar o funil de consórcio.</p>'; console.error(resLeads.error); return; }
    const acao = new Map((resAcao.data || []).map((a) => [a.lead_id, a]));
    const todos = resLeads.data || [];
    const soAcao = document.getElementById('fcSoAcao').checked;
    const mostrarPerdidos = document.getElementById('fcMostrarPerdidos').checked;
    const perdidos = todos.filter((l) => l.status === 'perdido' || l.status === 'perdido_definitivo');
    const ativos = todos.filter((l) => !perdidos.includes(l));
    const lista = soAcao ? ativos.filter((l) => acao.has(l.id)) : ativos;

    const emAndamento = ativos.filter((l) => !String(l.status).startsWith('pos_venda_')).length;
    const clientes = ativos.filter((l) => String(l.status).startsWith('pos_venda_')).length;
    const pedemAcao = ativos.filter((l) => acao.has(l.id)).length;
    document.getElementById('fcResumo').innerHTML =
      `<span class="fc-pilula">Em andamento: <b>${emAndamento}</b></span>` +
      `<span class="fc-pilula">Clientes no pós-venda: <b>${clientes}</b></span>` +
      `<span class="fc-pilula ${pedemAcao ? 'fc-alerta' : ''}">Pedem ação: <b>${pedemAcao}</b></span>` +
      `<span class="fc-pilula">Perdidos: <b>${perdidos.length}</b></span>`;

    const colunas = COLUNAS.slice();
    if (mostrarPerdidos) colunas.push({ id: 'perdidos', titulo: 'Perdidos', dica: 'Motivo registrado no lead', st: ['perdido', 'perdido_definitivo'] });
    const base = mostrarPerdidos ? (soAcao ? lista : lista.concat(perdidos)) : lista;

    board.innerHTML = colunas.map((col) => {
      const doGrupo = base.filter((l) => col.st.includes(l.status));
      if (col.ocultaSeVazia && !doGrupo.length) return '';
      return `
        <div class="kanban-col">
          <div class="kanban-col-head"><span>${esc(col.titulo)}<span class="fc-col-dica">${esc(col.dica)}</span></span><span class="kanban-col-count">${doGrupo.length}</span></div>
          <div class="kanban-cards">
            ${doGrupo.length ? doGrupo.map((l) => cartao(l, acao.get(l.id), col)).join('') : '<p class="kanban-empty">Nenhum lead aqui.</p>'}
          </div>
        </div>`;
    }).join('');
  }

  function cartao(l, a, col) {
    const dias = a ? a.dias_na_etapa : diasNaEtapa(l);
    const atraso = a && a.dias_de_atraso > 0;
    const zap = linkWhats(l.telefone);
    const chips = [l.bem_consorcio && esc(l.bem_consorcio), l.credito_desejado && 'crédito ' + brl(l.credito_desejado), l.parcela_desejada && 'parcela ' + brl(l.parcela_desejada), l.entrada_disponivel && 'entrada ' + brl(l.entrada_disponivel), l.origem && esc(l.origem)]
      .filter(Boolean).map((c) => `<span class="fc-chip">${c}</span>`).join('');
    const opcoes = ETAPAS.slice();
    if (!ROTULO[l.status] || l.status === 'perdido_definitivo' || String(l.status).startsWith('visita_')) opcoes.unshift([l.status, ROTULO[l.status] || String(l.status).replace(/_/g, ' ')]);
    return `
      <div class="kanban-card">
        <div class="fc-card-nome"><strong>${esc(l.nome)}</strong>${zap ? `<a class="fc-zap" href="${zap}" target="_blank" rel="noopener" title="Chamar no WhatsApp">WhatsApp</a>` : ''}</div>
        <small>${esc(l.telefone || 'sem telefone')}</small>
        ${col.st.length > 1 ? `<span class="fc-etapa">${esc(ROTULO[l.status] || l.status)}</span>` : ''}
        <div>${chips}</div>
        <span class="fc-tempo ${atraso ? 'fc-vencido' : ''}">⏱ ${dias === 0 ? 'entrou hoje nesta etapa' : plural(dias, 'dia', 'dias') + ' nesta etapa'}</span>
        ${a ? `<div class="fc-acao">⏰ ${esc(a.titulo)}${atraso ? ' (atrasado ' + plural(a.dias_de_atraso, 'dia', 'dias') + ')' : ''}</div>` : ''}
        ${gestao() ? `<span class="kanban-card-corretor">${esc(l.usuarios?.nome || 'Sem corretor')}</span>` : ''}
        <select class="status-select fc-mover" data-fc="mover" data-id="${esc(l.id)}">
          ${opcoes.map(([v, t]) => `<option value="${esc(v)}" ${v === l.status ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </div>`;
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
    if (t && t.dataset && t.dataset.fc === 'mover') moverLead(t.dataset.id, t.value);
    if (t && (t.id === 'fcFiltroCorretor' || t.id === 'fcSoAcao' || t.id === 'fcMostrarPerdidos')) carregarFunil();
    if (t && (t.id === 'pcPeriodo' || t.id === 'pcCorretor')) carregarPainel();
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'fcAtualizar') carregarFunil();
    if (e.target && e.target.id === 'pcAtualizar') carregarPainel();
  });

  // =====================================================================
  // 2) PAINEL
  // =====================================================================
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  const linhaFunil = (rotulo, valor, total, verde) =>
    `<div class="fc-barra-linha"><span>${esc(rotulo)}</span><div class="fc-trilho"><div class="fc-barra ${verde ? 'fc-verde' : ''}" style="width:${total ? Math.max(valor / total * 100, valor ? 2 : 0) : 0}%"></div></div><span class="fc-num"><b>${valor}</b> · ${pct(valor, total)}</span></div>`;

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

    const stat = (valor, rotulo, classe) => `<div class="stat-card ${classe || ''}"><div class="stat-value">${valor}</div><div class="stat-label">${rotulo}</div></div>`;
    const ordemEtapas = ETAPAS.map((e) => e[0]).concat(['perdido_definitivo', 'visita_agendada', 'visita_feita']);
    const linhasEtapa = ordemEtapas.filter((s) => etapa[s]).map((s) => `<tr><td>${esc(ROTULO[s] || String(s).replace(/_/g, ' '))}</td><td class="fc-r">${etapa[s]}</td></tr>`).join('');
    const linhasOrigem = (p.por_origem || []).map((o) => `<tr><td>${esc(o.origem)}</td><td class="fc-r">${o.qtd}</td></tr>`).join('');
    const linhasCorretor = (p.por_corretor || []).map((c) => `<tr><td class="fc-nome" title="${esc(c.corretor)}">${esc(c.corretor)}</td><td class="fc-r">${c.novos}</td><td class="fc-r">${c.em_andamento}</td><td class="fc-r">${c.adesoes}</td></tr>`).join('');
    const motivos = ((p.perdidos || {}).motivos || []).map((m) => `<tr><td>${esc(m.motivo)}</td><td class="fc-r">${m.qtd}</td></tr>`).join('');

    box.innerHTML = `
      <div class="fc-grade">
        ${stat(p.novos_no_periodo, 'Leads novos no período')}
        ${stat(p.em_andamento, 'Em andamento agora')}
        ${stat(p.acoes_atrasadas, 'Pedem ação agora', p.acoes_atrasadas ? 'stat-danger' : '')}
        ${stat(f.adesao || 0, 'Adesões (leads do período)', 'stat-success')}
        ${stat(brl(p.credito_em_andamento) || 'R$ 0', 'Crédito desejado em andamento')}
        ${stat(tempoTxt, 'Tempo até o 1º contato (mediana)')}
      </div>
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
        <div class="panel"><div class="panel-head"><h2>Perdidos no período: ${(p.perdidos || {}).total || 0}</h2></div>
          ${motivos ? `<table class="fc-tab"><thead><tr><th>Motivo</th><th class="fc-r">Qtd.</th></tr></thead><tbody>${motivos}</tbody></table>` : '<p class="table-empty">Nenhum lead perdido no período.</p>'}</div>
      </div>`;
  }

  window.FunilConsorcio = { carregarFunil, carregarPainel };
})();
