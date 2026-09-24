const $ = (sel, ctx = document) => ctx.querySelector(sel);

// URL pública do site — usada para gerar links/QR codes (ex: fotos da vistoria)
const SITE_URL_PUBLICO = 'https://gregoriomeular-site.netlify.app';
const $$ = (sel, ctx = document) => ctx.querySelectorAll(sel);

// =====================================================================
// TOAST
// =====================================================================
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// =====================================================================
// MODAL GENÉRICO
// =====================================================================
let modalPersistente = false;
function openModal(html, opts = {}) {
  $('#modalBody').innerHTML = html;
  $('#modalContent').classList.toggle('modal-wide', !!opts.wide);
  $('#modalOverlay').classList.add('open');
  modalPersistente = opts.persistente !== false; // por padrão, toda aba só fecha pelo X — evita perder o que já foi preenchido
}
function closeModal() {
  $('#modalOverlay').classList.remove('open');
  $('#modalBody').innerHTML = '';
  $('#modalContent').classList.remove('modal-wide');
  modalPersistente = false;
}
$('#modalClose').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', (e) => {
  if (e.target.id !== 'modalOverlay') return;
  if (modalPersistente) { toast('Clique no X para fechar sem perder o que já foi preenchido.'); return; }
  closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modalPersistente) return;
  closeModal();
});

// =====================================================================
// TEMA (claro / escuro)
// Padrão é escuro. A escolha fica em localStorage (aplica na hora, sem
// piscar) e também em usuarios.tema (segue o usuário em outro aparelho).
// =====================================================================
function temaAtual() {
  return document.documentElement.getAttribute('data-theme') === 'claro' ? 'claro' : 'escuro';
}

function sincronizarBotaoTema() {
  const btn = $('#temaToggle');
  if (!btn) return;
  const claro = temaAtual() === 'claro';
  btn.textContent = claro ? '☀️' : '🌙';
  btn.title = claro ? 'Mudar para o tema escuro' : 'Mudar para o tema claro';
}

function aplicarTema(tema, salvarNoBanco) {
  const t = tema === 'claro' ? 'claro' : 'escuro';
  if (t === 'escuro') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', 'claro');
  try { localStorage.setItem('crm-tema', t); } catch (e) { /* modo privado */ }
  sincronizarBotaoTema();
  if (salvarNoBanco && currentUsuario?.id && currentUsuario.tema !== t) {
    currentUsuario.tema = t;
    supabase.from('usuarios').update({ tema: t }).eq('id', currentUsuario.id)
      .then(({ error }) => { if (error) console.error('Não foi possível salvar o tema:', error.message); });
  }
}

$('#temaToggle')?.addEventListener('click', () => {
  aplicarTema(temaAtual() === 'claro' ? 'escuro' : 'claro', true);
});
sincronizarBotaoTema();

// =====================================================================
// AVISO DE NOVO LEAD (Realtime) — enquanto o CRM estiver aberto, o corretor
// recebe um toast + contador na aba Leads quando um lead cai pra ele.
// =====================================================================
const TITULO_BASE_CRM = document.title;
let leadsNaoVistos = 0;
let leadsJaConhecidos = new Set();
let canalRealtimeLeads = null;

function atualizarBadgeLeads() {
  const btn = $('.nav-item[data-view="leads"]');
  if (btn) {
    let badge = btn.querySelector('.nav-badge');
    if (leadsNaoVistos > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; btn.appendChild(badge); }
      badge.textContent = leadsNaoVistos > 9 ? '9+' : String(leadsNaoVistos);
    } else if (badge) {
      badge.remove();
    }
  }
  document.title = leadsNaoVistos > 0 ? `(${leadsNaoVistos > 9 ? '9+' : leadsNaoVistos}) ${TITULO_BASE_CRM}` : TITULO_BASE_CRM;
}

function tocarBipLead() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    o.start(); o.stop(ctx.currentTime + 0.33);
    setTimeout(() => ctx.close(), 500);
  } catch (e) { /* navegador bloqueou áudio — tudo bem */ }
}

function tratarLeadRealtime(lead) {
  if (!lead || !lead.id) return;
  if (String(lead.corretor_id) !== String(currentUsuario?.id)) return; // não é meu
  if (leadsJaConhecidos.has(lead.id)) return; // já era meu / já avisei
  leadsJaConhecidos.add(lead.id);
  const naViewLeads = !$('#view-leads')?.hidden;
  if (!naViewLeads) { leadsNaoVistos += 1; atualizarBadgeLeads(); }
  const detalhe = [lead.interesse, lead.origem].filter(Boolean).join(' · ') || 'novo contato';
  toast(`🔔 Novo lead: ${lead.nome} — ${detalhe}`);
  tocarBipLead();
  if (naViewLeads) loadLeads();
}

async function iniciarRealtimeLeads() {
  if (!currentUsuario?.id || canalRealtimeLeads) return;
  // pré-carrega os leads que já são meus, pra distinguir "novo" de "atualização"
  const { data } = await supabase.from('leads').select('id').eq('corretor_id', currentUsuario.id);
  (data || []).forEach((l) => leadsJaConhecidos.add(l.id));
  const filtro = `corretor_id=eq.${currentUsuario.id}`;
  canalRealtimeLeads = supabase.channel('rt-leads-corretor')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads', filter: filtro }, (p) => tratarLeadRealtime(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'leads', filter: filtro }, (p) => tratarLeadRealtime(p.new))
    .subscribe();
}

// =====================================================================
// AUTENTICAÇÃO
// =====================================================================
let currentUsuario = null;
let podeVerFinanceiro = false;
let souGerente = false; // true apenas para cargo === 'gerente' — usado para autorizar exclusões
let souGestaoPortais = false; // true para admin ou gerente — autoriza adicionar/editar portais externos (XML)
let souAnalistaDoc = false; // true para cargo === 'analista_doc' — só enxerga a aba Aprovações
let podeVerAprovacoes = false; // true para admin/gerente/analista_doc — cria e edita processos de aprovação

async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await showApp(session);
  } else {
    showLogin();
  }
}

function showLogin() {
  $('#loginScreen').hidden = false;
  $('#appShell').hidden = true;
}

async function showApp(session) {
  $('#loginScreen').hidden = true;
  $('#appShell').hidden = false;
  $('#userEmail').textContent = session.user.email;

  const { data: usuario } = await supabase.from('usuarios').select('*').eq('auth_user_id', session.user.id).maybeSingle();
  currentUsuario = usuario || null;

  // Tema salvo do usuário (sobrepõe o que veio do localStorage, se diferente)
  if (currentUsuario?.tema) aplicarTema(currentUsuario.tema, false);

  const podeVerFinanceiro_local = currentUsuario && ['admin', 'gerente'].includes(currentUsuario.cargo);
  podeVerFinanceiro = podeVerFinanceiro_local;
  souGerente = !!(currentUsuario && currentUsuario.cargo === 'gerente');
  souGestaoPortais = !!(currentUsuario && ['admin', 'gerente'].includes(currentUsuario.cargo));
  souAnalistaDoc = currentUsuario?.cargo === 'analista_doc';
  podeVerAprovacoes = podeVerFinanceiro_local || souAnalistaDoc;
  $$('.nav-financeiro').forEach((btn) => { btn.hidden = !podeVerFinanceiro; });
  // Portais externos (filtro de portal/nível, resumo de destaques e toolbar de XML)
  // só para admin/gerente — corretor não gerencia portais.
  $$('.so-gestao-portais').forEach((el) => { el.hidden = !souGestaoPortais; });

  // Aba Aprovações: gestão + analista editam; corretor vê só leitura dos processos dos clientes dele.
  const veAbaAprovacoes = podeVerAprovacoes || currentUsuario?.cargo === 'corretor';
  $$('.nav-aprovacoes').forEach((el) => { el.hidden = !veAbaAprovacoes; });

  if (souAnalistaDoc) {
    // Analista de Documentação: menu enxuto — só Aprovações e Ajuda.
    $$('.nav-item, .topnav-group, .topnav-trigger').forEach((el) => { el.hidden = true; });
    $$('.nav-aprovacoes').forEach((el) => { el.hidden = false; });
    const ajuda = $('.nav-item[data-view="tutorial"]');
    if (ajuda) ajuda.hidden = false;
    navigateTo('aprovacoes');
    return;
  }

  iniciarRealtimeLeads();
  navigateTo('dashboard');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const errorEl = $('#loginError');
  errorEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Entrando...';

  const email = $('#login-email').value.trim();
  const password = $('#login-senha').value;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'Entrar';

  if (error) {
    errorEl.textContent = 'E-mail ou senha inválidos.';
    errorEl.hidden = false;
    return;
  }
  showApp(data.session);
});

$('#logoutBtn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  showLogin();
});

// =====================================================================
// ESQUECI MINHA SENHA
// =====================================================================
$('#forgotBtn').addEventListener('click', () => {
  $('#loginForm').hidden = true;
  $('#forgotForm').hidden = false;
});

$('#backToLoginBtn').addEventListener('click', () => {
  $('#forgotForm').hidden = true;
  $('#loginForm').hidden = false;
});

$('#forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#forgotBtnSubmit');
  const feedback = $('#forgotFeedback');
  btn.disabled = true;
  btn.textContent = 'Enviando...';

  const email = $('#forgot-email').value.trim();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname.replace('index.html', '') + 'reset-password.html',
  });

  btn.disabled = false;
  btn.textContent = 'Enviar link';
  feedback.hidden = false;
  feedback.textContent = error
    ? 'Não foi possível enviar agora. Tente novamente em instantes.'
    : 'Se esse e-mail estiver cadastrado, o link de redefinição já foi enviado.';
});

// =====================================================================
// NAVEGAÇÃO ENTRE VIEWS
// =====================================================================
const VIEWS = ['dashboard', 'leads', 'oferta_ativa', 'funil', 'captacao', 'imoveis', 'pessoas', 'visitas', 'vistorias', 'contratos', 'gerador', 'historico_docs', 'financeiro', 'relatorios', 'auditoria', 'equipe', 'depoimentos', 'hero', 'momentos', 'site', 'tutorial', 'aprovacoes', 'treinamento'];

function navigateTo(view) {
  VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  fecharTodosDropdowns();
  const itemAtivo = $(`.nav-item[data-view="${view}"]`);
  const painelPai = itemAtivo?.closest('.topnav-dropdown');
  $$('.topnav-trigger').forEach((t) => t.classList.remove('group-active'));
  if (painelPai) {
    const gatilho = painelPai.previousElementSibling;
    if (gatilho && gatilho.classList.contains('topnav-trigger')) gatilho.classList.add('group-active');
  }

  if (view === 'dashboard') loadDashboard();
  if (view === 'leads') { leadsNaoVistos = 0; atualizarBadgeLeads(); loadLeads(); }
  if (view === 'oferta_ativa') loadOfertaAtiva();
  if (view === 'funil') loadFunil();
  if (view === 'captacao') loadCaptacao();
  if (view === 'imoveis') loadImoveis();
  if (view === 'pessoas') loadPessoas();
  if (view === 'visitas') loadVisitas();
  if (view === 'vistorias') loadVistorias();
  if (view === 'contratos') loadContratos();
  if (view === 'gerador') loadGeradorView();
  if (view === 'historico_docs') carregarHistoricoDocumentos();
  if (view === 'financeiro') { loadCobrancas(); loadRepasses(); loadVendas(); loadLocacoesResumo(); }
  if (view === 'equipe') loadEquipe();
  if (view === 'depoimentos') loadDepoimentos();
  if (view === 'hero') loadHero();
  if (view === 'momentos') loadMomentosCRM();
  if (view === 'site') loadConfigSite();
  if (view === 'relatorios') carregarRelatorios();
  if (view === 'auditoria') carregarAuditoria();
  if (view === 'tutorial') carregarTutorial();
  if (view === 'aprovacoes') loadAprovacoes();
  if (view === 'treinamento') iniciarTreinamento();
}

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => { if (!btn.dataset.view) return; limparFiltrosAlerta(); navigateTo(btn.dataset.view); }));

// ---- tela de Treinamento: destaca o item do menu lateral conforme a rolagem ----
let treinamentoInicializado = false;
function iniciarTreinamento() {
  if (treinamentoInicializado) return;
  treinamentoInicializado = true;
  const wrap = $('#view-treinamento');
  if (!wrap) return;
  const sections = wrap.querySelectorAll('section.role');
  const navLinks = wrap.querySelectorAll('.nav-list a');
  if (!sections.length) return;
  const setActive = () => {
    let current = sections[0].id;
    sections.forEach((s) => { if (window.scrollY >= s.offsetTop - 140) current = s.id; });
    navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + current));
  };
  document.addEventListener('scroll', setActive);
  setActive();
}

// ---- menu no topo: abrir/fechar dropdowns de cada grupo ----
function fecharTodosDropdowns() {
  $$('.topnav-dropdown.open').forEach((p) => p.classList.remove('open'));
}
$$('.topnav-trigger').forEach((trigger) => {
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const painel = trigger.nextElementSibling;
    const jaAberto = painel.classList.contains('open');
    fecharTodosDropdowns();
    if (!jaAberto) painel.classList.add('open');
  });
});
document.addEventListener('click', () => fecharTodosDropdowns());
$$('.topnav-dropdown').forEach((p) => p.addEventListener('click', (e) => e.stopPropagation()));

// =====================================================================
// FORMATTERS
// =====================================================================
function money(v) { return v ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : '—'; }
function dateTime(v) { return v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
function statusPill(status, motivo) {
  const titleAttr = (status === 'inativo' && motivo) ? ` title="Motivo: ${motivo.replace(/"/g, '&quot;')}"` : '';
  const label = LEAD_STATUS_LABELS[status] || status.replace(/_/g, ' ');
  return `<span class="status-pill status-${status}"${titleAttr}>${label}</span>`;
}

function firstFoto(fotos) {
  try {
    const arr = Array.isArray(fotos) ? fotos : JSON.parse(fotos || '[]');
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  } catch { return null; }
}
function emptyRow(cols, msg) { return `<tr><td colspan="${cols}" class="table-empty">${msg}</td></tr>`; }

// =====================================================================
// DASHBOARD
// =====================================================================
async function loadDashboard() {
  const [leadsNovos, imoveisDisp, visitasAgendadas, leadsTotal] = await Promise.all([
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'novo'),
    supabase.from('imoveis').select('id', { count: 'exact', head: true }).eq('status', 'disponivel'),
    supabase.from('visitas').select('id', { count: 'exact', head: true }).eq('status', 'agendada'),
    supabase.from('leads').select('id', { count: 'exact', head: true }),
  ]);

  $('#statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-value">${leadsNovos.count ?? 0}</div><div class="stat-label">Leads novos</div></div>
    <div class="stat-card"><div class="stat-value">${leadsTotal.count ?? 0}</div><div class="stat-label">Leads no total</div></div>
    <div class="stat-card"><div class="stat-value">${imoveisDisp.count ?? 0}</div><div class="stat-label">Imóveis disponíveis</div></div>
    <div class="stat-card"><div class="stat-value">${visitasAgendadas.count ?? 0}</div><div class="stat-label">Visitas agendadas</div></div>
  `;

  const { data, error } = await supabase.from('leads').select('*').order('criado_em', { ascending: false }).limit(6);
  const tbody = $('#dashLeadsTable tbody');
  if (error || !data?.length) { tbody.innerHTML = emptyRow(1, 'Nenhum lead ainda.'); return; }
  tbody.innerHTML = data.map((l) => `
    <tr><td><strong>${l.nome}</strong></td><td>${l.telefone}</td><td>${l.origem}</td><td>${statusPill(l.status)}</td></tr>
  `).join('');

  if (podeVerFinanceiro) {
    $('#rankingPanel').hidden = false;
    loadRanking();
    $('#painelExecutivoLocacao').hidden = false;
    carregarPainelExecutivoLocacao();
    const escopoSel = $('#tarefasFiltroEscopo');
    if (escopoSel) escopoSel.hidden = false;
  }
  loadTarefas();
}

// =====================================================================
// TAREFAS & LEMBRETES (Dashboard, todos os usuários — cada um vê as suas;
// gerente/admin podem alternar para ver as de toda a equipe)
// =====================================================================
let tarefasCache = [];

async function loadTarefas() {
  const wrap = $('#tarefasLista');
  if (!wrap) return;
  const escopoSel = $('#tarefasFiltroEscopo');
  const verTodas = podeVerFinanceiro && escopoSel && !escopoSel.hidden && escopoSel.value === 'todas';

  let query = supabase.from('tarefas')
    .select('*, usuarios!tarefas_responsavel_id_fkey(nome), leads(nome)')
    .eq('concluida', false)
    .order('prazo', { ascending: true, nullsFirst: false })
    .order('criado_em', { ascending: true });
  if (!verTodas) query = query.eq('responsavel_id', currentUsuario.id);

  const { data, error } = await query;
  if (error) { wrap.innerHTML = '<p class="dash-vazio">Erro ao carregar tarefas.</p>'; console.error(error); return; }
  tarefasCache = data || [];
  renderTarefas(verTodas);
}

function renderTarefas(mostrarResponsavel) {
  const wrap = $('#tarefasLista');
  if (!wrap) return;
  if (!tarefasCache.length) { wrap.innerHTML = '<p class="dash-vazio">Nenhuma tarefa pendente. 🎉</p>'; return; }

  const hoje = new Date().toISOString().slice(0, 10);
  wrap.innerHTML = tarefasCache.map((t) => {
    const atrasada = t.prazo && t.prazo < hoje;
    const éHoje = t.prazo === hoje;
    const classePrazo = atrasada ? 'tarefa-atrasada' : (éHoje ? 'tarefa-hoje' : '');
    const prazoTexto = t.prazo ? new Date(t.prazo + 'T00:00:00').toLocaleDateString('pt-BR') : null;
    return `
      <div class="tarefa-item">
        <input type="checkbox" class="tarefa-check" data-action="tarefa-concluir" data-id="${t.id}" title="Marcar como concluída">
        <div class="tarefa-corpo">
          <div class="tarefa-titulo">${escapeHtml(t.titulo)}</div>
          <div class="tarefa-meta">
            ${prazoTexto ? `<span class="tarefa-prazo ${classePrazo}">${atrasada ? '⚠️ ' : ''}${prazoTexto}</span>` : ''}
            ${t.leads?.nome ? `<span>· lead: ${escapeHtml(t.leads.nome)}</span>` : ''}
            ${mostrarResponsavel && t.usuarios?.nome ? `<span>· ${escapeHtml(t.usuarios.nome)}</span>` : ''}
          </div>
        </div>
        <button type="button" class="tarefa-excluir" data-action="tarefa-excluir" data-id="${t.id}" title="Excluir tarefa">✕</button>
      </div>
    `;
  }).join('');
}

function tarefaFormHtml(usuariosEquipe) {
  const opcoesResponsavel = podeVerFinanceiro
    ? `<div class="form-row full"><label>Responsável</label>
        <select id="tarefa-responsavel">${(usuariosEquipe || []).map((u) => `<option value="${u.id}" ${u.id === currentUsuario.id ? 'selected' : ''}>${u.nome}</option>`).join('')}</select>
      </div>`
    : '';
  const opcoesLead = leadsCache.length
    ? `<div class="form-row full"><label>Vincular a um lead (opcional)</label>
        <select id="tarefa-lead"><option value="">— Nenhum —</option>${leadsCache.map((l) => `<option value="${l.id}">${l.nome}</option>`).join('')}</select>
      </div>`
    : '';
  return `
    <h2>Nova tarefa</h2>
    <form class="modal-form" id="tarefaForm">
      <div class="form-row full"><label>Título</label><input required id="tarefa-titulo" placeholder="Ex: Ligar pro cliente sobre financiamento"></div>
      <div class="form-row"><label>Prazo (opcional)</label><input type="date" id="tarefa-prazo"></div>
      ${opcoesResponsavel}
      ${opcoesLead}
      <div class="form-row full"><label>Descrição (opcional)</label><textarea id="tarefa-descricao" rows="2"></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelTarefa">Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar tarefa</button>
      </div>
    </form>
  `;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#novaTarefaBtn')) {
    let usuariosEquipe = [];
    if (podeVerFinanceiro) {
      const { data } = await supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome');
      usuariosEquipe = data || [];
    }
    if (!leadsCache.length) { const { data } = await supabase.from('leads').select('id,nome').order('nome'); leadsCache = data || []; }
    openModal(tarefaFormHtml(usuariosEquipe), {});
    $('#cancelTarefa').addEventListener('click', closeModal);
    $('#tarefaForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const payload = {
        titulo: $('#tarefa-titulo').value.trim(),
        prazo: $('#tarefa-prazo').value || null,
        descricao: $('#tarefa-descricao').value.trim() || null,
        lead_id: $('#tarefa-lead')?.value || null,
        responsavel_id: $('#tarefa-responsavel')?.value || currentUsuario.id,
        criado_por: currentUsuario.id,
      };
      const { error } = await supabase.from('tarefas').insert(payload);
      if (error) { toast('Erro ao criar tarefa: ' + error.message, true); return; }
      toast('Tarefa criada.');
      closeModal();
      loadTarefas();
    });
  }

  const chkConcluir = e.target.closest('[data-action="tarefa-concluir"]');
  if (chkConcluir) {
    chkConcluir.disabled = true;
    const { error } = await supabase.from('tarefas').update({ concluida: true, concluida_em: new Date().toISOString() }).eq('id', chkConcluir.dataset.id);
    if (error) { toast('Erro ao concluir tarefa: ' + error.message, true); chkConcluir.disabled = false; return; }
    toast('Tarefa concluída.');
    loadTarefas();
  }

  const btnExcluirTarefa = e.target.closest('[data-action="tarefa-excluir"]');
  if (btnExcluirTarefa) {
    if (!confirm('Excluir esta tarefa?')) return;
    const { error } = await supabase.from('tarefas').delete().eq('id', btnExcluirTarefa.dataset.id);
    if (error) { toast('Erro ao excluir tarefa: ' + error.message, true); return; }
    loadTarefas();
  }
});

$('#tarefasFiltroEscopo')?.addEventListener('change', loadTarefas);

// =====================================================================
// PAINEL EXECUTIVO DE LOCAÇÃO (Dashboard, gerente/admin)
// Visão consolidada: contratos de locação, recebimentos de inquilinos por
// vencimento, repasses estimados aos proprietários por dia fixo (02/12/22)
// e a carteira de imóveis (locação e venda) por status.
// =====================================================================
function diasEntre(dataIso) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const alvo = new Date(dataIso + 'T00:00:00');
  return Math.round((alvo - hoje) / (1000 * 60 * 60 * 24));
}

async function carregarPainelExecutivoLocacao() {
  const hoje = new Date();
  const inicioMesIso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;

  const [
    { data: contratosLocacao, error: erroContratos },
    { data: cobrancasAbertas, error: erroCobrancas },
    { data: cobrancasPagasMes, error: erroPagas },
    { data: imoveisTodos, error: erroImoveis },
    { data: leadsParados, error: erroLeadsParados },
    { data: imoveisSemFoto, error: erroImoveisSemFoto },
    { data: imoveisFeedIw, error: erroImoveisFeedIw },
  ] = await Promise.all([
    supabase.from('contratos').select('id,status,data_fim,dia_repasse').eq('tipo', 'locacao'),
    supabase.from('cobrancas')
      .select('id,valor_base,data_vencimento,data_pagamento,isento_multa_juros,contratos!inner(tipo,multa_percentual,juros_diario_percentual,imoveis(titulo),pessoas!contratos_comprador_locatario_id_fkey(nome)),cobranca_ajustes(*)')
      .eq('contratos.tipo', 'locacao')
      .is('data_pagamento', null)
      .order('data_vencimento', { ascending: true }),
    // Repasses a fazer: cobranças já pagas pelo inquilino neste mês — usa a
    // mesma fórmula da tela "Repasses" (valor_base × (1 − taxa) + ajustes).
    supabase.from('cobrancas')
      .select('id,valor_base,referencia,repasse_efetivado_em,contratos!inner(tipo,taxa_administracao_percentual,dia_repasse,data_inicio,retem_primeiro_aluguel,imoveis(titulo),pessoas!contratos_vendedor_locador_id_fkey(nome)),cobranca_ajustes(*)')
      .eq('contratos.tipo', 'locacao')
      .not('data_pagamento', 'is', null)
      .gte('referencia', inicioMesIso),
    supabase.from('imoveis').select('id,status,finalidade'),
    supabase.from('leads').select('id,nome,status,criado_em,usuarios(nome)').in('status', ['novo', 'tentativa_1', 'tentativa_2', 'tentativa_3']).lt('criado_em', new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()).order('criado_em', { ascending: true }),
    supabase.from('imoveis').select('id,titulo,fotos').eq('status', 'disponivel'),
    // Imóveis que deveriam estar no feed do Imovelweb (mesmo filtro usado pela Netlify Function
    // /feed/imovelweb.xml) — pra detectar o que está travando a entrada ou pesando no Quality Score.
    supabase.from('imoveis')
      .select('id,codigo,titulo,finalidade,situacao,cidade,bairro,cep,area_total,area_construida,valor_venda,valor_locacao,fotos')
      .eq('status', 'disponivel').eq('publicado', true).contains('portais_publicacao', ['imovelweb']),
  ]);

  if (erroContratos || erroCobrancas || erroPagas || erroImoveis) {
    console.error('Erro ao carregar painel executivo de locação:', erroContratos || erroCobrancas || erroPagas || erroImoveis);
    return;
  }

  // ---- KPIs do topo ----
  const locacaoAtivos = (contratosLocacao || []).filter((c) => c.status === 'ativo');
  const locacaoInadimplentes = (contratosLocacao || []).filter((c) => c.status === 'inadimplente');
  const em30dias = (contratosLocacao || []).filter((c) => c.status === 'ativo' && c.data_fim && diasEntre(c.data_fim) >= 0 && diasEntre(c.data_fim) <= 30);

  const cobrancasCalc = (cobrancasAbertas || []).map((cb) => {
    const contrato = cb.contratos || {};
    const ajustesCalc = calcularAjustes(cb.cobranca_ajustes || []);
    const valorBaseComAjuste = Math.round((Number(cb.valor_base) + ajustesCalc.deltaInquilino) * 100) / 100;
    const dias = diasEmAtraso(cb.data_vencimento, cb.data_pagamento);
    const atualizado = valorAtualizado(valorBaseComAjuste, contrato.multa_percentual ?? 2, contrato.juros_diario_percentual ?? 1, dias, cb.isento_multa_juros);
    return { ...cb, contrato, atualizado, diasAtraso: dias, diasParaVencer: diasEntre(cb.data_vencimento) };
  });
  const totalEmAberto = cobrancasCalc.reduce((s, cb) => s + cb.atualizado, 0);

  const repassesCalc = (cobrancasPagasMes || []).map((cb) => {
    const contrato = cb.contratos || {};
    const taxa = contrato.taxa_administracao_percentual ?? 10;
    const { ajusteProprietario } = calcularAjustes(cb.cobranca_ajustes || []);
    // 1º aluguel 100% imobiliária: só zera o repasse se ainda não foi efetivado
    // (não reescreve repasses antigos já marcados como feitos).
    const primeiroAluguelRetido = (contrato.retem_primeiro_aluguel ?? true)
      && ehMesDoPrimeiroAluguel(contrato.data_inicio, cb.referencia)
      && !cb.repasse_efetivado_em;
    const repasseBase = primeiroAluguelRetido ? 0 : Math.round(Number(cb.valor_base) * (1 - taxa / 100) * 100) / 100;
    const repasse = Math.round((repasseBase + ajusteProprietario) * 100) / 100;
    return { ...cb, contrato, taxa, repasse, primeiroAluguelRetido, diaRepasse: contrato.dia_repasse ?? null };
  });
  const totalRepassesMes = repassesCalc.reduce((s, r) => s + r.repasse, 0);

  $('#painelExecStats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${locacaoAtivos.length}</div><div class="stat-label">Contratos de locação ativos</div></div>
    <div class="stat-card stat-danger"><div class="stat-value">${locacaoInadimplentes.length}</div><div class="stat-label">Contratos inadimplentes</div></div>
    <div class="stat-card stat-warning"><div class="stat-value">${em30dias.length}</div><div class="stat-label">Vencendo em até 30 dias</div></div>
    <div class="stat-card stat-info"><div class="stat-value">${money(totalEmAberto)}</div><div class="stat-label">Em aberto com inquilinos</div></div>
    <div class="stat-card stat-success"><div class="stat-value">${money(totalRepassesMes)}</div><div class="stat-label">Repasses apurados este mês</div></div>
  `;

  renderPainelRecebimentos(cobrancasCalc);
  renderPainelRepasses(repassesCalc);
  renderCarteiraImoveis(imoveisTodos || []);

  const diaHoje = hoje.getDate();
  const recebimentosAtraso = cobrancasCalc.filter((cb) => cb.diasAtraso > 0);
  const repassesAtraso = repassesCalc.filter((r) => r.diaRepasse && r.diaRepasse < diaHoje && !r.repasse_efetivado_em && !r.primeiroAluguelRetido);
  const imoveisProblemaFeed = diagnosticarImoveisFeedImovelweb(imoveisFeedIw || []);

  idsImoveisFeedProblema = imoveisProblemaFeed.map((im) => im.id);
  motivosImoveisFeedProblema = new Map(imoveisProblemaFeed.map((im) => [im.id, im.motivos]));
  idsCobrancasAtraso = new Set(recebimentosAtraso.map((cb) => cb.id));
  idsRepassesAtraso = new Set(repassesAtraso.map((r) => r.id));

  renderPainelAlertas({
    contratosSemDiaRepasse: locacaoAtivos.filter((c) => !c.dia_repasse),
    leadsParados: leadsParados || [],
    imoveisSemFoto: (imoveisSemFoto || []).filter((im) => !im.fotos || im.fotos.length === 0),
    recebimentosAtraso,
    repassesAtraso,
    imoveisProblemaFeed,
    erroExtra: erroLeadsParados || erroImoveisSemFoto || erroImoveisFeedIw,
  });
}

// Replica as mesmas regras da Netlify Function /feed/imovelweb.xml (netlify/functions/feed-imovelweb.mts)
// pra avisar ANTES de publicar quando um imóvel vai ficar de fora do feed ou entrar com qualidade fraca.
function diagnosticarImoveisFeedImovelweb(imoveis) {
  const problemas = [];
  imoveis.forEach((im) => {
    // Lançamento fora de Curitiba é exclusão intencional (regra combinada com a Imovelweb), não é bug.
    if (im.situacao === 'lancamento' && semAcento(im.cidade || '') !== 'curitiba') return;

    const motivos = [];
    const fotos = Array.isArray(im.fotos) ? im.fotos : [];
    if (fotos.length < 5) motivos.push({ texto: `Só ${fotos.length} foto${fotos.length === 1 ? '' : 's'} (precisa de 5+)`, bloqueia: true });

    const temPrecoVenda = (im.finalidade === 'venda' || im.finalidade === 'venda_locacao') && im.valor_venda;
    const temPrecoLocacao = (im.finalidade === 'locacao' || im.finalidade === 'venda_locacao') && im.valor_locacao;
    if (!temPrecoVenda && !temPrecoLocacao) motivos.push({ texto: 'Sem preço cadastrado pra finalidade do anúncio', bloqueia: true });

    if (!im.cep) motivos.push({ texto: 'CEP não preenchido', bloqueia: false });
    if (!im.bairro) motivos.push({ texto: 'Bairro não preenchido — cai pro nível cidade e perde Quality Score', bloqueia: false });
    if (!im.cidade) motivos.push({ texto: 'Cidade não preenchida', bloqueia: false });
    if (!im.area_total && !im.area_construida) motivos.push({ texto: 'Área (m²) não preenchida', bloqueia: false });

    if (motivos.length) problemas.push({ id: im.id, codigo: im.codigo, titulo: im.titulo, motivos });
  });
  return problemas;
}

function renderPainelAlertas({ contratosSemDiaRepasse, leadsParados, imoveisSemFoto, recebimentosAtraso, repassesAtraso, imoveisProblemaFeed, erroExtra }) {
  const wrap = $('#painelAlertas');
  if (!wrap) return;
  if (erroExtra) console.error('Erro ao carregar alertas operacionais:', erroExtra);

  const itens = [
    {
      qtd: recebimentosAtraso.length,
      texto: `<strong>${recebimentosAtraso.length}</strong> recebimento${recebimentosAtraso.length === 1 ? '' : 's'} de aluguel em atraso com inquilino${recebimentosAtraso.length === 1 ? '' : 's'}.`,
      nivel: 'atencao',
      tipo: 'recebimentos_atraso',
    },
    {
      qtd: repassesAtraso.length,
      texto: `<strong>${repassesAtraso.length}</strong> repasse${repassesAtraso.length === 1 ? '' : 's'} a proprietário${repassesAtraso.length === 1 ? '' : 's'} com o dia de repasse já vencido este mês.`,
      nivel: 'atencao',
      tipo: 'repasses_atraso',
    },
    {
      qtd: imoveisProblemaFeed.length,
      texto: `<strong>${imoveisProblemaFeed.length}</strong> imóve${imoveisProblemaFeed.length === 1 ? 'l' : 'is'} marcado${imoveisProblemaFeed.length === 1 ? '' : 's'} pro Imovelweb com problema (fotos, preço, CEP, bairro, cidade ou área) — afeta a entrada ou a qualidade no feed.`,
      nivel: 'atencao',
      tipo: 'imoveis_feed',
    },
    {
      qtd: contratosSemDiaRepasse.length,
      texto: `<strong>${contratosSemDiaRepasse.length}</strong> contrato${contratosSemDiaRepasse.length === 1 ? '' : 's'} de locação ativo${contratosSemDiaRepasse.length === 1 ? '' : 's'} sem dia de repasse definido — não aparece${contratosSemDiaRepasse.length === 1 ? '' : 'm'} no painel de repasses até ser corrigido em Locação → Contratos.`,
      nivel: 'atencao',
      tipo: 'contratos_repasse',
    },
    {
      qtd: leadsParados.length,
      texto: `<strong>${leadsParados.length}</strong> lead${leadsParados.length === 1 ? '' : 's'} parado${leadsParados.length === 1 ? '' : 's'} há mais de 5 dias sem avançar no funil — risco de esfriar.`,
      nivel: 'atencao',
      tipo: 'leads_parados',
    },
    {
      qtd: imoveisSemFoto.length,
      texto: `<strong>${imoveisSemFoto.length}</strong> imóve${imoveisSemFoto.length === 1 ? 'l' : 'is'} disponíve${imoveisSemFoto.length === 1 ? 'l' : 'is'} sem nenhuma foto cadastrada — prejudica a divulgação no site.`,
      nivel: 'atencao',
      tipo: 'imoveis_sem_foto',
    },
  ];

  wrap.innerHTML = itens.map((it) => {
    if (it.qtd === 0) return `<div class="alerta-item alerta-ok"><span class="alerta-texto">✅ Tudo certo por aqui.</span></div>`;
    return `
      <button type="button" class="alerta-item alerta-${it.nivel} alerta-clicavel" data-action="ir-alerta" data-tipo="${it.tipo}">
        <span class="alerta-texto">${it.texto}</span>
        <span class="alerta-corrigir">Corrigir →</span>
      </button>
    `;
  }).join('');
}

// Filtros ativados ao clicar num Alerta Operacional do Dashboard — levam direto
// à tela certa já filtrada só com os itens daquele alerta, um por vez.
let filtroContratosSemRepasse = false;
let filtroLeadsParados = false;
let filtroImoveisSemFoto = false;
let filtroImoveisFeed = false;
let filtroCobrancasAtraso = false;
let filtroRepassesAtraso = false;
let filtroDiaRepasse = '';
let filtroFaixaVencimento = '';
let idsImoveisFeedProblema = [];
let motivosImoveisFeedProblema = new Map();
let idsCobrancasAtraso = new Set();
let idsRepassesAtraso = new Set();

function limparFiltrosAlerta() {
  filtroContratosSemRepasse = false;
  filtroLeadsParados = false;
  filtroImoveisSemFoto = false;
  filtroImoveisFeed = false;
  filtroCobrancasAtraso = false;
  filtroRepassesAtraso = false;
}

document.addEventListener('click', async (e) => {
  const btnIr = e.target.closest('[data-action="ir-alerta"]');
  if (btnIr) {
    limparFiltrosAlerta();
    const tipo = btnIr.dataset.tipo;
    let bannerId = null;
    if (tipo === 'contratos_repasse') { filtroContratosSemRepasse = true; navigateTo('contratos'); await loadContratos(); bannerId = 'contratosAlertaBanner'; }
    if (tipo === 'leads_parados') { filtroLeadsParados = true; navigateTo('leads'); await loadLeads(); bannerId = 'leadsAlertaBanner'; }
    if (tipo === 'imoveis_sem_foto') { filtroImoveisSemFoto = true; navigateTo('imoveis'); await loadImoveis(); bannerId = 'imoveisAlertaBanner'; }
    if (tipo === 'imoveis_feed') { filtroImoveisFeed = true; navigateTo('imoveis'); await loadImoveis(); bannerId = 'imoveisAlertaBanner'; }
    if (tipo === 'recebimentos_atraso') { filtroCobrancasAtraso = true; navigateTo('financeiro'); $('.financeiro-tab[data-financeiro-tab="locacoes"]')?.click(); await loadCobrancas(); bannerId = 'cobrancasAlertaBanner'; }
    if (tipo === 'repasses_atraso') { filtroRepassesAtraso = true; navigateTo('financeiro'); $('.financeiro-tab[data-financeiro-tab="repasses"]')?.click(); await loadRepasses(); bannerId = 'repassesAlertaBanner'; }
    if (bannerId) $(`#${bannerId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Se sobrou só 1 item na lista filtrada, já abre direto o card/modal dele — não faz
    // sentido mostrar uma lista de 1 pra depois o usuário ter que clicar de novo.
    const seletorUnico = {
      contratos_repasse: '#contratosCards [data-action="contrato-edit"]',
      imoveis_sem_foto: '#imoveisCards [data-action="imovel-edit"]',
      imoveis_feed: '#imoveisCards [data-action="imovel-edit"]',
      leads_parados: '#leadsTable tbody [data-action="lead-view"]',
    }[tipo];
    if (seletorUnico) {
      const botoes = $$(seletorUnico);
      if (botoes.length === 1) botoes[0].click();
    }
    return;
  }
  const btnLimpar = e.target.closest('[data-action="limpar-filtro-alerta"]');
  if (btnLimpar) {
    limparFiltrosAlerta();
    if (btnLimpar.dataset.tela === 'contratos') renderContratosCards();
    if (btnLimpar.dataset.tela === 'leads') renderLeadsTable();
    if (btnLimpar.dataset.tela === 'imoveis') renderImoveisTable();
    if (btnLimpar.dataset.tela === 'cobrancas') renderCobrancasCards();
    if (btnLimpar.dataset.tela === 'repasses') loadRepasses();
  }
});

function renderPainelRecebimentos(cobrancasCalc) {
  const wrap = $('#painelRecebimentos');
  if (!wrap) return;
  if (!cobrancasCalc.length) { wrap.innerHTML = '<p class="dash-vazio">Nenhuma cobrança em aberto no momento — tudo em dia. 🎉</p>'; return; }

  const buckets = [
    { titulo: 'Atrasados', filtro: (cb) => cb.diasAtraso > 0, classe: 'venc-atrasado' },
    { titulo: 'Vencendo hoje', filtro: (cb) => cb.diasAtraso === 0 && cb.diasParaVencer === 0, classe: 'venc-hoje' },
    { titulo: 'Próximos 7 dias', filtro: (cb) => cb.diasAtraso === 0 && cb.diasParaVencer > 0 && cb.diasParaVencer <= 7, classe: '' },
    { titulo: 'Próximos 30 dias', filtro: (cb) => cb.diasAtraso === 0 && cb.diasParaVencer > 7 && cb.diasParaVencer <= 30, classe: '' },
  ];

  let html = '';
  buckets.forEach((b) => {
    const doGrupo = cobrancasCalc.filter(b.filtro);
    if (!doGrupo.length) return;
    const total = doGrupo.reduce((s, cb) => s + cb.atualizado, 0);
    html += `<div class="dash-bucket-titulo">${b.titulo} — ${doGrupo.length} · <span class="dash-repasse-total">${money(total)}</span></div>`;
    html += doGrupo.slice(0, 8).map((cb) => `
      <div class="dash-linha-item">
        <div>
          <div class="dash-linha-nome">${escapeHtml(cb.contrato.imoveis?.titulo || 'Imóvel não vinculado')}</div>
          <div class="dash-linha-sub">${escapeHtml(cb.contrato.pessoas?.nome || '')} · vence ${new Date(cb.data_vencimento + 'T00:00:00').toLocaleDateString('pt-BR')}${cb.diasAtraso > 0 ? ` · ${cb.diasAtraso} dia${cb.diasAtraso > 1 ? 's' : ''} em atraso` : ''}</div>
        </div>
        <div class="dash-linha-valor ${b.classe}">${money(cb.atualizado)}</div>
      </div>
    `).join('');
    if (doGrupo.length > 8) html += `<div class="dash-linha-sub" style="padding:4px 0;">+ ${doGrupo.length - 8} outra${doGrupo.length - 8 > 1 ? 's' : ''} nesta faixa — ver em Locação → Cobranças.</div>`;
  });
  wrap.innerHTML = html || '<p class="dash-vazio">Nenhuma cobrança nos próximos 30 dias.</p>';
}

function renderPainelRepasses(repassesCalc) {
  const wrap = $('#painelRepasses');
  if (!wrap) return;
  const comDia = repassesCalc.filter((r) => r.diaRepasse);
  if (!comDia.length) {
    wrap.innerHTML = repassesCalc.length
      ? '<p class="dash-vazio">Há repasses apurados este mês, mas nenhum contrato correspondente tem dia de repasse definido.</p>'
      : '<p class="dash-vazio">Nenhum aluguel pago neste mês ainda — os repasses aparecem aqui assim que o inquilino paga.</p>';
    return;
  }

  let html = '';
  [2, 12, 22].forEach((dia) => {
    const doGrupo = comDia.filter((r) => r.diaRepasse === dia);
    if (!doGrupo.length) return;
    const totalDia = doGrupo.reduce((s, r) => s + r.repasse, 0);
    html += `<div class="dash-bucket-titulo">Dia ${String(dia).padStart(2, '0')} — ${doGrupo.length} repasse${doGrupo.length > 1 ? 's' : ''} · <span class="dash-repasse-total">${money(totalDia)}</span></div>`;
    html += doGrupo.map((r) => `
      <div class="dash-linha-item">
        <div>
          <div class="dash-linha-nome">${escapeHtml(r.contrato.pessoas?.nome || 'Proprietário não vinculado')}${r.repasse_efetivado_em ? ' <span class="badge-mini" title="Repasse já feito">✓ repassado</span>' : ''}</div>
          <div class="dash-linha-sub">${escapeHtml(r.contrato.imoveis?.titulo || '')} · taxa adm. ${r.taxa}%</div>
        </div>
        <div class="dash-linha-valor">${money(r.repasse)}</div>
      </div>
    `).join('');
  });
  wrap.innerHTML = html || '<p class="dash-vazio">Nenhum repasse com dia definido este mês.</p>';
}

let chartImoveisLocacaoInst = null;
let chartImoveisVendaInst = null;

function renderCarteiraImoveis(imoveis) {
  const paraLocacao = imoveis.filter((im) => im.finalidade === 'locacao' || im.finalidade === 'venda_locacao');
  const paraVenda = imoveis.filter((im) => im.finalidade === 'venda' || im.finalidade === 'venda_locacao');

  const locacaoContagem = {
    disponivel: paraLocacao.filter((im) => im.status === 'disponivel').length,
    alugado: paraLocacao.filter((im) => im.status === 'alugado').length,
    inativo: paraLocacao.filter((im) => im.status === 'inativo').length,
  };
  const vendaContagem = {
    disponivel: paraVenda.filter((im) => im.status === 'disponivel' || im.status === 'reservado').length,
    vendido: paraVenda.filter((im) => im.status === 'vendido').length,
    inativo: paraVenda.filter((im) => im.status === 'inativo').length,
  };

  chartImoveisLocacaoInst = renderDonutImoveis(
    'chartImoveisLocacao', 'legendaImoveisLocacao', chartImoveisLocacaoInst,
    [
      { label: 'Disponíveis', valor: locacaoContagem.disponivel, cor: '#4caf7d' },
      { label: 'Alugados', valor: locacaoContagem.alugado, cor: '#4a86e8' },
      { label: 'Inativos', valor: locacaoContagem.inativo, cor: '#e0555f' },
    ],
  );
  chartImoveisVendaInst = renderDonutImoveis(
    'chartImoveisVenda', 'legendaImoveisVenda', chartImoveisVendaInst,
    [
      { label: 'Ativos', valor: vendaContagem.disponivel, cor: '#4caf7d' },
      { label: 'Vendidos', valor: vendaContagem.vendido, cor: '#FF6A1A' },
      { label: 'Inativos', valor: vendaContagem.inativo, cor: '#e0555f' },
    ],
  );
}

function renderDonutImoveis(canvasId, legendaId, instanciaAnterior, itens) {
  const canvas = $(`#${canvasId}`);
  const legenda = $(`#${legendaId}`);
  if (!canvas || typeof Chart === 'undefined') return null;
  if (instanciaAnterior) instanciaAnterior.destroy();

  const total = itens.reduce((s, i) => s + i.valor, 0);
  legenda.innerHTML = total
    ? itens.map((i) => `
        <div class="dash-legenda-item">
          <span class="dash-legenda-nome"><span class="dash-legenda-dot" style="background:${i.cor}"></span>${i.label}</span>
          <strong>${i.valor} <span class="dash-linha-sub">(${Math.round((i.valor / total) * 100)}%)</span></strong>
        </div>
      `).join('')
    : '<p class="dash-vazio">Nenhum imóvel cadastrado nesta categoria ainda.</p>';

  return new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: itens.map((i) => i.label),
      datasets: [{ data: itens.map((i) => i.valor), backgroundColor: itens.map((i) => i.cor), borderColor: '#0B1E3D', borderWidth: 2 }],
    },
    options: {
      cutout: '68%',
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      maintainAspectRatio: false,
    },
  });
}

async function loadRanking() {
  const tbody = $('#rankingTable tbody');
  if (!tbody) return;
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);

  const [{ data: corretores }, { data: contratosMes }] = await Promise.all([
    supabase.from('usuarios').select('id,nome,meta_mensal').eq('ativo', true).order('nome'),
    supabase.from('contratos').select('corretor_id, comissao_valor, status, criado_em').gte('criado_em', inicioMes.toISOString()),
  ]);

  const porCorretor = {};
  (corretores || []).forEach((c) => { porCorretor[c.id] = { nome: c.nome, meta: c.meta_mensal || 0, negocios: 0, comissao: 0 }; });
  (contratosMes || []).forEach((c) => {
    if (!c.corretor_id || !porCorretor[c.corretor_id]) return;
    if (c.status === 'ativo' || c.status === 'encerrado') {
      porCorretor[c.corretor_id].negocios += 1;
      porCorretor[c.corretor_id].comissao += Number(c.comissao_valor || 0);
    }
  });

  const ranking = Object.values(porCorretor).sort((a, b) => b.comissao - a.comissao);
  if (!ranking.length) { tbody.innerHTML = emptyRow(6, 'Nenhum corretor ativo cadastrado ainda.'); return; }

  tbody.innerHTML = ranking.map((r, i) => {
    const pctMeta = r.meta > 0 ? Math.round((r.comissao / r.meta) * 100) : null;
    return `
      <tr>
        <td>${i + 1}º</td>
        <td><strong>${r.nome}</strong></td>
        <td>${r.negocios}</td>
        <td>${money(r.comissao)}</td>
        <td>${r.meta ? money(r.meta) : '—'}</td>
        <td>${pctMeta !== null ? pctMeta + '%' : '—'}</td>
      </tr>
    `;
  }).join('');
}

// =====================================================================
// LEADS
// =====================================================================
const LEAD_STATUSES = ['novo', 'tentativa_1', 'tentativa_2', 'tentativa_3', 'busca_qualificada', 'consulta_simulacao', 'visita_agendada', 'visita_feita', 'alterar_busca', 'proposta', 'documentacao', 'assinaturas', 'pos_venda_30', 'pos_venda_60', 'pos_venda_90', 'pos_venda_120', 'perdido'];
const LEAD_STATUS_LABELS = {
  novo: 'Novo',
  tentativa_1: '1ª Tentativa',
  tentativa_2: '2ª Tentativa',
  tentativa_3: '3ª Tentativa',
  busca_qualificada: 'Busca Qualificada',
  consulta_simulacao: 'Consulta Simulação',
  visita_agendada: 'Visita Agendada',
  visita_feita: 'Visita Feita',
  alterar_busca: 'Alterar Busca',
  proposta: 'Proposta',
  documentacao: 'Documentação',
  assinaturas: 'Assinaturas',
  pos_venda_30: 'Pós-venda 30 dias',
  pos_venda_60: 'Pós-venda 60 dias',
  pos_venda_90: 'Pós-venda 90 dias',
  pos_venda_120: 'Pós-venda 120 dias',
  perdido: 'Lead Frio Perdido',
};

const ORIGENS_LEAD = ['site', 'whatsapp', 'instagram', 'facebook', 'indicacao', 'portal_imoveis', 'placas', 'google', 'ligacao', 'presencial', 'outro'];
const INTERESSES_LEAD = ['compra', 'venda', 'locacao', 'avaliacao', 'outro'];

let leadsCache = [];
let leadsCorretoresCache = [];
// Filtro "por corretor" na lista de Leads — só admin/gerente veem e usam (mesmo padrão do Funil e da Captação).
let leadsFiltroCorretorId = '';
let leadsFiltroCorretoresCarregados = false;

async function loadLeads() {
  const tbody = $('#leadsTable tbody');
  const filtro = $('#leadStatusFilter').value;

  const wrapFiltroCorretor = $('#leadsFiltroCorretorWrap');
  if (wrapFiltroCorretor) wrapFiltroCorretor.hidden = !podeVerFinanceiro;

  if (podeVerFinanceiro && !leadsFiltroCorretoresCarregados) {
    const { data: todosCorretores } = await supabase.from('usuarios').select('id,nome').order('nome');
    const selectFiltro = $('#leadsFiltroCorretor');
    (todosCorretores || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nome;
      selectFiltro.appendChild(opt);
    });
    leadsFiltroCorretoresCarregados = true;
  }

  let query = supabase.from('leads').select('*, usuarios(nome)')
    .order('atualizado_em', { ascending: false, nullsFirst: false })
    .order('criado_em', { ascending: false });
  if (filtro) query = query.eq('status', filtro);
  if (podeVerFinanceiro && leadsFiltroCorretorId) query = query.eq('corretor_id', leadsFiltroCorretorId);

  const [{ data, error }, { data: corretores }] = await Promise.all([
    query,
    leadsCorretoresCache.length ? Promise.resolve({ data: leadsCorretoresCache }) : supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome'),
  ]);
  if (corretores) leadsCorretoresCache = corretores;
  if (error) { tbody.innerHTML = emptyRow(7, 'Erro ao carregar leads.'); console.error(error); return; }
  leadsCache = data || [];
  renderLeadsTable();
}

function renderLeadsTable() {
  const tbody = $('#leadsTable tbody');
  const banner = $('#leadsAlertaBanner');
  const termo = semAcento(($('#leadsSearch')?.value || '').trim());
  let filtrados = termo
    ? leadsCache.filter((l) => semAcento([l.nome, l.telefone].filter(Boolean).join(' ')).includes(termo))
    : leadsCache;

  if (filtroLeadsParados) {
    const limite = Date.now() - 5 * 24 * 60 * 60 * 1000;
    filtrados = filtrados.filter((l) => ['novo', 'tentativa_1', 'tentativa_2', 'tentativa_3'].includes(l.status) && new Date(l.criado_em).getTime() < limite);
  }
  if (banner) {
    banner.hidden = !filtroLeadsParados;
    if (filtroLeadsParados) {
      banner.innerHTML = `<span>🔔 Mostrando <strong>${filtrados.length}</strong> lead${filtrados.length === 1 ? '' : 's'} parado${filtrados.length === 1 ? '' : 's'} há mais de 5 dias.</span><button type="button" class="btn btn-ghost btn-sm" data-action="limpar-filtro-alerta" data-tela="leads">Limpar filtro</button>`;
    }
  }

  if (!filtrados.length) { tbody.innerHTML = emptyRow(7, filtroLeadsParados ? 'Nenhum lead parado — tudo em dia! 🎉' : (leadsCache.length ? 'Nenhum lead encontrado para essa busca.' : 'Nenhum lead encontrado.')); return; }

  tbody.innerHTML = filtrados.map((l) => `
    <tr>
      <td>${nomeLeadEditavelHtml(l)}</td>
      <td>${l.telefone}</td>
      <td>${l.origem}</td>
      <td>${l.interesse || '—'}</td>
      <td>
        <select class="status-select" data-id="${l.id}" data-action="lead-status">
          ${LEAD_STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${LEAD_STATUS_LABELS[s]}</option>`).join('')}
        </select>
      </td>
      <td>
        <select class="corretor-select" data-id="${l.id}" data-action="lead-corretor">
          <option value="">— Sem corretor —</option>
          ${leadsCorretoresCache.map((c) => `<option value="${c.id}" ${c.id === l.corretor_id ? 'selected' : ''}>${c.nome}</option>`).join('')}
        </select>
      </td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="lead-view" data-id="${l.id}">Ver</button>
        <button class="btn btn-ghost btn-sm" data-action="lead-para-captacao" data-id="${l.id}" title="Cliente quer vender/locar imóvel, ou é construtora/incorporadora">→ Captação</button>
      </td>
    </tr>
  `).join('');
}

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action !== 'lead-para-captacao') return;
  const lead = leadsCache.find((l) => l.id === e.target.dataset.id);
  if (!lead) return;
  const papelPorInteresse = { venda: 'vendedor', locacao: 'locador', avaliacao: 'vendedor' };
  const finalidadePorInteresse = { venda: 'venda_usado', locacao: 'locacao_residencial' };
  openModal(await captacaoForm({
    leadId: lead.id,
    nome: lead.nome,
    telefone: lead.telefone,
    papel: papelPorInteresse[lead.interesse] || 'vendedor',
    finalidade: finalidadePorInteresse[lead.interesse] || 'venda_usado',
    obs: lead.observacoes ? `Do lead: ${lead.observacoes}` : '',
  }), { persistente: true });
  bindCaptacaoForm();
});

$('#leadStatusFilter').addEventListener('change', loadLeads);
$('#leadsSearch').addEventListener('input', renderLeadsTable);
$('#leadsFiltroCorretor')?.addEventListener('change', (e) => {
  leadsFiltroCorretorId = e.target.value;
  loadLeads();
});

async function leadForm(l = {}) {
  const [{ data: imoveis }, { data: corretores }] = await Promise.all([
    supabase.from('imoveis').select('id,titulo').order('titulo'),
    supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome'),
  ]);
  return `
    <h2>Novo lead</h2>
    <form class="modal-form" id="leadForm">
      <div class="form-row full"><label>Nome</label><input required id="l-nome" value="${l.nome || ''}"></div>
      <div class="form-row"><label>Telefone</label><input required id="l-telefone" value="${l.telefone || ''}"></div>
      <div class="form-row"><label>E-mail</label><input type="email" id="l-email" value="${l.email || ''}"></div>
      <div class="form-row"><label>Origem</label>
        <select id="l-origem">${ORIGENS_LEAD.map((o) => `<option value="${o}">${o.replace(/_/g, ' ')}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>Interesse</label>
        <select id="l-interesse">
          <option value="">—</option>
          ${INTERESSES_LEAD.map((i) => `<option value="${i}">${i}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Imóvel de interesse (opcional)</label>
        <select id="l-imovel">
          <option value="">—</option>
          ${(imoveis || []).map((im) => `<option value="${im.id}">${im.titulo}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Corretor responsável (opcional — se deixar em branco, o sistema distribui automaticamente)</label>
        <select id="l-corretor">
          <option value="">Distribuir automaticamente</option>
          ${(corretores || []).map((c) => `<option value="${c.id}">${c.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Observações</label><textarea id="l-obs" rows="2"></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelLead">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar lead</button>
      </div>
    </form>
  `;
}

$('#newLeadBtn').addEventListener('click', async () => {
  openModal(await leadForm());
  $('#cancelLead').addEventListener('click', closeModal);
  $('#leadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Salvando...';
    const payload = {
      nome: $('#l-nome').value.trim(),
      telefone: $('#l-telefone').value.trim(),
      email: $('#l-email').value.trim() || null,
      origem: $('#l-origem').value,
      interesse: $('#l-interesse').value || null,
      imovel_id: $('#l-imovel').value || null,
      corretor_id: $('#l-corretor').value || null,
      observacoes: $('#l-obs').value.trim() || null,
      status: 'novo',
    };
    const { error } = await supabase.from('leads').insert(payload);
    btn.disabled = false; btn.textContent = 'Salvar lead';
    if (error) { toast('Erro ao salvar lead: ' + error.message, true); console.error(error); return; }
    toast('Lead cadastrado.');
    closeModal();
    loadLeads();
    loadDashboard();
  });
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset.action === 'lead-status') {
    const novoStatus = e.target.value;
    const agora = new Date().toISOString();
    const payload = { status: novoStatus, atualizado_em: agora };
    if (novoStatus === 'perdido') {
      const motivo = window.prompt('Motivo da perda do negócio (preço, financiamento, concorrente, desistência...):', '');
      if (motivo && motivo.trim()) payload.motivo_perda = motivo.trim();
    }
    const { error } = await supabase.from('leads').update(payload).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar o status.', true); return; }
    toast('Status do lead atualizado.');
    aplicarAtualizacaoLeadLocal(e.target.dataset.id, payload);
    loadDashboard();
  }
  if (e.target.dataset.action === 'lead-corretor') {
    const agora = new Date().toISOString();
    const payload = { corretor_id: e.target.value || null, atualizado_em: agora };
    const { error } = await supabase.from('leads').update(payload).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível trocar o corretor.', true); return; }
    toast('Corretor do lead atualizado.');
    // corretor_id sozinho não reflete o nome do corretor no card/linha — recarrega os
    // dois pra trazer o usuarios(nome) atualizado do servidor, já na ordem nova.
    loadLeads();
    if ($('#view-funil') && !$('#view-funil').hidden) loadFunil();
    loadDashboard();
  }
});

// ---------------------------------------------------------------------
// "Subir para cabeçalho": o último lead acessado (aberto pra ver) ou editado
// (status, corretor, nome, busca do cliente, nova interação) fica no topo da
// lista de Leads e no topo da sua coluna no Funil de Vendas. A ordem "de
// verdade" vem do banco (order by atualizado_em) — o que fazemos aqui é só
// aplicar a mesma mudança nos caches já carregados na tela, pra reordenar na
// hora, sem esperar um recarregamento completo.
function comparaAtualizacao(a, b) {
  const ta = new Date(a.atualizado_em || a.criado_em).getTime();
  const tb = new Date(b.atualizado_em || b.criado_em).getTime();
  return tb - ta;
}

function aplicarAtualizacaoLeadLocal(id, patch) {
  const emLista = leadsCache.find((l) => l.id === id);
  if (emLista) Object.assign(emLista, patch);
  const emFunil = funilLeadsCache.find((l) => l.id === id);
  if (emFunil) Object.assign(emFunil, patch);

  leadsCache.sort(comparaAtualizacao);
  funilLeadsCache.sort(comparaAtualizacao);

  if (emLista && $('#leadsTable')) renderLeadsTable();
  if (emFunil && $('#kanbanBoard')) renderFunilBoard();
}

// ---------------------------------------------------------------------
// Nome do lead editável direto no card (funil, lista e detalhe)
// ---------------------------------------------------------------------
function nomeLeadEditavelHtml(l) {
  return `<span class="lead-nome-wrap" data-id="${l.id}"><strong class="lead-nome-txt">${escapeHtml(l.nome)}</strong><button type="button" class="lead-nome-edit" data-action="lead-nome-editar" data-id="${l.id}" title="Corrigir nome" aria-label="Corrigir nome do lead">✏️</button></span>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="lead-nome-editar"], [data-action="lead-nome-salvar"], [data-action="lead-nome-cancelar"]');
  if (!btn) return;
  const acao = btn.dataset.action;
  const wrap = btn.closest('.lead-nome-wrap');
  if (!wrap) return;
  const id = wrap.dataset.id;

  if (acao === 'lead-nome-editar') {
    const atual = wrap.querySelector('.lead-nome-txt')?.textContent || '';
    wrap.dataset.nomeAtual = atual;
    wrap.classList.add('editando');
    wrap.innerHTML = `<input type="text" class="lead-nome-input" value="${escapeHtml(atual)}" maxlength="120" aria-label="Nome do lead"><button type="button" class="lead-nome-ok" data-action="lead-nome-salvar" title="Salvar">✓</button><button type="button" class="lead-nome-cancel" data-action="lead-nome-cancelar" title="Cancelar">✕</button>`;
    const inp = wrap.querySelector('.lead-nome-input');
    inp.focus(); inp.select();
    return;
  }

  const restaurar = (nome) => {
    wrap.classList.remove('editando');
    wrap.innerHTML = `<strong class="lead-nome-txt">${escapeHtml(nome)}</strong><button type="button" class="lead-nome-edit" data-action="lead-nome-editar" data-id="${id}" title="Corrigir nome" aria-label="Corrigir nome do lead">✏️</button>`;
  };

  if (acao === 'lead-nome-cancelar') { restaurar(wrap.dataset.nomeAtual || ''); return; }

  // salvar
  const novo = (wrap.querySelector('.lead-nome-input')?.value || '').trim().replace(/\s+/g, ' ');
  const antigo = wrap.dataset.nomeAtual || '';
  if (!novo) { toast('O nome não pode ficar vazio.', true); return; }
  if (novo === antigo) { restaurar(antigo); return; }
  btn.disabled = true;
  const agoraNome = new Date().toISOString();
  const { error } = await supabase.from('leads').update({ nome: novo, atualizado_em: agoraNome }).eq('id', id);
  if (error) { btn.disabled = false; toast('Não foi possível corrigir o nome.', true); console.error(error); return; }
  restaurar(novo);
  // sincroniza o mesmo lead em outras telas abertas (lista, funil, título do detalhe)
  $$(`.lead-nome-wrap[data-id="${id}"]`).forEach((w) => {
    if (w === wrap || w.classList.contains('editando')) return;
    const t = w.querySelector('.lead-nome-txt'); if (t) t.textContent = novo;
  });
  aplicarAtualizacaoLeadLocal(id, { nome: novo, atualizado_em: agoraNome });
  toast('Nome do lead atualizado.');
});

document.addEventListener('keydown', (e) => {
  if (!e.target.classList?.contains('lead-nome-input')) return;
  const wrap = e.target.closest('.lead-nome-wrap');
  if (e.key === 'Enter') { e.preventDefault(); wrap.querySelector('[data-action="lead-nome-salvar"]').click(); }
  if (e.key === 'Escape') { e.preventDefault(); wrap.querySelector('[data-action="lead-nome-cancelar"]').click(); }
});

async function carregarInteracoesLead(leadId) {
  const { data, error } = await supabase.from('interacoes').select('*').eq('lead_id', leadId).order('criado_em', { ascending: true });
  const wrap = $('#leadInteracoesLista');
  if (!wrap) return;
  if (error) { wrap.innerHTML = '<p class="table-empty">Erro ao carregar histórico.</p>'; return; }
  if (!data.length) { wrap.innerHTML = '<p class="table-empty">Nenhuma interação registrada ainda.</p>'; return; }
  wrap.innerHTML = data.map((i) => `
    <div class="interacao-item">
      <div class="interacao-meta"><strong>${i.canal}</strong> · ${i.direcao === 'enviada' ? 'enviada' : 'recebida'} · ${dateTime(i.criado_em)}${i.automatica ? ' · automática' : ''}</div>
      <div class="interacao-texto">${i.mensagem}</div>
    </div>
  `).join('');
}

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'lead-view') {
    // Abrir o histórico já conta como "acesso": some pra cabeçalho da lista/coluna.
    const agoraVer = new Date().toISOString();
    const { data: l } = await supabase.from('leads').update({ atualizado_em: agoraVer }).eq('id', e.target.dataset.id).select('*').single();
    if (!l) return;
    aplicarAtualizacaoLeadLocal(l.id, { atualizado_em: agoraVer });
    openModal(`
      <h2>${nomeLeadEditavelHtml(l)}</h2>
      <p><strong>Telefone:</strong> ${l.telefone}</p>
      <p><strong>E-mail:</strong> ${l.email || '—'}</p>
      <p><strong>Origem:</strong> ${l.origem}</p>
      ${(l.campanha || l.utm_campaign || l.anuncio) ? `<p><strong>Campanha:</strong> ${[l.campanha || l.utm_campaign, l.conjunto, l.anuncio].filter(Boolean).join(' · ')}</p>` : ''}
      <p><strong>Observações:</strong> ${l.observacoes || '—'}</p>
      ${l.status === 'perdido' && l.motivo_perda ? `<p><strong>Motivo da perda:</strong> ${l.motivo_perda}</p>` : ''}
      <p><strong>Criado em:</strong> ${dateTime(l.criado_em)}</p>

      <h3 style="margin-top:18px;">🔎 Busca do cliente</h3>
      <form class="modal-form" id="leadBuscaForm">
        <div class="form-row"><label>Interesse</label>
          <select id="lb-interesse">
            ${INTERESSES_LEAD.map((i) => `<option value="${i}" ${i === l.interesse ? 'selected' : ''}>${i.replace(/_/g, ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>Tipo de imóvel</label>
          <select id="lb-tipo">
            <option value="">— Qualquer —</option>
            ${TIPOS_IMOVEL.map((t) => `<option value="${t}" ${t === l.tipo_imovel_busca ? 'selected' : ''}>${t.replace(/_/g, ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-row full"><label>Região / bairro desejado</label><input id="lb-regiao" value="${l.regiao_busca || ''}" placeholder="Ex: Eucaliptos, Veneza, próximo à BR-116..."></div>
        <div class="form-row"><label>Valor mínimo</label><input id="lb-valor-min" type="number" step="0.01" value="${l.valor_min ?? ''}" placeholder="R$"></div>
        <div class="form-row"><label>Valor máximo</label><input id="lb-valor-max" type="number" step="0.01" value="${l.valor_max ?? ''}" placeholder="R$"></div>
        <div class="form-row"><label>Quartos (mínimo)</label><input id="lb-quartos" type="number" min="0" value="${l.quartos_min ?? ''}"></div>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary btn-sm">💾 Salvar busca</button>
        </div>
      </form>

      <h3 style="margin-top:18px;">Histórico de interações</h3>
      <div class="interacoes-lista" id="leadInteracoesLista"><p class="table-empty">Carregando...</p></div>
      <form class="modal-form interacao-form" id="interacaoForm" style="margin-top:10px;">
        <input type="hidden" id="int-lead-id" value="${l.id}">
        <div class="form-row"><label>Canal</label>
          <select id="int-canal">
            <option value="whatsapp">WhatsApp</option>
            <option value="telefone">Telefone</option>
            <option value="email">E-mail</option>
            <option value="presencial">Presencial</option>
            <option value="site">Site</option>
          </select>
        </div>
        <div class="form-row"><label>Direção</label>
          <select id="int-direcao">
            <option value="enviada">Enviada (eu falei)</option>
            <option value="recebida">Recebida (cliente falou)</option>
          </select>
        </div>
        <div class="form-row full"><label>Anotação</label><textarea id="int-mensagem" rows="2" required placeholder="Ex: liguei, cliente disse que quer visitar sábado de manhã"></textarea></div>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary btn-sm">Adicionar ao histórico</button>
        </div>
      </form>
    `);
    carregarInteracoesLead(l.id);
    $('#leadBuscaForm').addEventListener('submit', async (e3) => {
      e3.preventDefault();
      const payload = {
        interesse: $('#lb-interesse').value,
        tipo_imovel_busca: $('#lb-tipo').value || null,
        regiao_busca: $('#lb-regiao').value.trim() || null,
        valor_min: $('#lb-valor-min').value ? Number($('#lb-valor-min').value) : null,
        valor_max: $('#lb-valor-max').value ? Number($('#lb-valor-max').value) : null,
        quartos_min: $('#lb-quartos').value ? Number($('#lb-quartos').value) : null,
        atualizado_em: new Date().toISOString(),
      };
      const { error } = await supabase.from('leads').update(payload).eq('id', l.id);
      if (error) { toast('Não foi possível salvar a busca.', true); console.error(error); return; }
      toast('Busca do cliente atualizada.');
      loadLeads();
      if ($('#view-funil') && !$('#view-funil').hidden) loadFunil();
    });
    $('#interacaoForm').addEventListener('submit', async (e2) => {
      e2.preventDefault();
      const mensagem = $('#int-mensagem').value.trim();
      if (!mensagem) return;
      const { error } = await supabase.from('interacoes').insert({
        lead_id: l.id,
        canal: $('#int-canal').value,
        direcao: $('#int-direcao').value,
        mensagem,
        automatica: false,
      });
      if (error) { toast('Não foi possível salvar a anotação.', true); console.error(error); return; }
      $('#int-mensagem').value = '';
      carregarInteracoesLead(l.id);
      // Registrar uma interação também conta como "editar" o lead — some pra cabeçalho.
      const agoraInteracao = new Date().toISOString();
      await supabase.from('leads').update({ atualizado_em: agoraInteracao }).eq('id', l.id);
      aplicarAtualizacaoLeadLocal(l.id, { atualizado_em: agoraInteracao });
    });
  }
});

// =====================================================================
// OFERTA ATIVA — fila de contatos para prospecção dos corretores
// =====================================================================
const OFERTA_ATIVA_LIMITE_DIARIO = 10;
let ofertaAtivaCache = [];
let ofertaAtivaEscolhidosHoje = 0;

function ofertaAtivaStatus(contato) {
  const exclusividadeExpirada = contato.exclusivo_ate && new Date(contato.exclusivo_ate) <= new Date();
  if (!contato.corretor_atual_id || exclusividadeExpirada) return { texto: 'Disponível', classe: 'status-disponivel', minha: false, bloqueada: false };
  if (currentUsuario && contato.corretor_atual_id === currentUsuario.id) return { texto: 'Seu contato', classe: 'status-novo', minha: true, bloqueada: false };
  const ateTxt = contato.exclusivo_ate ? new Date(contato.exclusivo_ate).toLocaleDateString('pt-BR') : '—';
  return { texto: `Com ${contato.usuarios?.nome || 'outro corretor'} até ${ateTxt}`, classe: 'status-perdido', minha: false, bloqueada: true };
}

async function loadOfertaAtiva() {
  $('#ofertaAtivaAdminPanel').hidden = !podeVerFinanceiro;
  const tbody = $('#ofertaAtivaTable tbody');

  const hojeInicio = new Date(); hojeInicio.setHours(0, 0, 0, 0);
  const [{ data: fila, error }, { data: meus, error: errorMeus }, { count: escolhidosHoje }] = await Promise.all([
    supabase.from('contatos_oferta_ativa').select('*, usuarios(nome)').eq('ativo', true).order('ordem', { ascending: true }).limit(100),
    // Os contatos já atribuídos a mim podem ter caído fora do limite acima (ao pegar,
    // o contato vai pro fim da fila) — busco eles à parte pra sempre aparecerem na tela.
    currentUsuario
      ? supabase.from('contatos_oferta_ativa').select('*, usuarios(nome)').eq('ativo', true).eq('corretor_atual_id', currentUsuario.id)
      : Promise.resolve({ data: [] }),
    currentUsuario
      ? supabase.from('oferta_ativa_escolhas').select('id', { count: 'exact', head: true }).eq('corretor_id', currentUsuario.id).gte('escolhido_em', hojeInicio.toISOString())
      : Promise.resolve({ count: 0 }),
  ]);

  if (error || errorMeus) { tbody.innerHTML = emptyRow(5, 'Erro ao carregar a fila de oferta ativa.'); console.error(error || errorMeus); return; }

  // meus contatos primeiro, depois o resto da fila na ordem original
  ofertaAtivaCache = [
    ...(meus || []),
    ...(fila || []).filter((c) => c.corretor_atual_id !== currentUsuario?.id),
  ];
  ofertaAtivaEscolhidosHoje = escolhidosHoje || 0;

  const restam = Math.max(0, OFERTA_ATIVA_LIMITE_DIARIO - ofertaAtivaEscolhidosHoje);
  const contadorEl = $('#ofertaAtivaContador');
  contadorEl.textContent = `Você já pegou ${ofertaAtivaEscolhidosHoje}/${OFERTA_ATIVA_LIMITE_DIARIO} hoje`;
  contadorEl.classList.toggle('status-perdido', restam === 0);
  contadorEl.classList.toggle('status-novo', restam > 0);

  renderOfertaAtivaTable();
}

function renderOfertaAtivaTable() {
  const tbody = $('#ofertaAtivaTable tbody');
  const termo = semAcento(($('#ofertaAtivaSearch')?.value || '').trim());
  const filtrados = termo
    ? ofertaAtivaCache.filter((c) => semAcento([c.nome, c.telefone].filter(Boolean).join(' ')).includes(termo))
    : ofertaAtivaCache;

  if (!filtrados.length) { tbody.innerHTML = emptyRow(5, ofertaAtivaCache.length ? 'Nenhum contato encontrado para essa busca.' : 'Nenhum contato na fila ainda.'); return; }

  const semLimiteHoje = ofertaAtivaEscolhidosHoje >= OFERTA_ATIVA_LIMITE_DIARIO;

  tbody.innerHTML = filtrados.map((c) => {
    const st = ofertaAtivaStatus(c);
    const bloqueadoPorOutro = st.bloqueada;
    const bloqueadoPorLimite = semLimiteHoje && !bloqueadoPorOutro;
    let botao;
    if (bloqueadoPorOutro) {
      botao = `<button class="btn btn-ghost btn-sm" disabled title="Contato já atribuído a outro corretor">Indisponível</button>`;
    } else if (st.minha) {
      botao = `
        <div class="btn-group-inline">
          <button class="btn btn-primary btn-sm" data-action="oferta-pegar" data-id="${c.id}">Pegar de novo</button>
          <button class="btn btn-danger btn-sm" data-action="oferta-devolver" data-id="${c.id}" title="Devolver este contato para a fila agora">Devolver contato</button>
        </div>`;
    } else if (bloqueadoPorLimite) {
      botao = `<button class="btn btn-ghost btn-sm" disabled title="Limite diário de 10 contatos atingido">Limite atingido</button>`;
    } else {
      botao = `<button class="btn btn-primary btn-sm" data-action="oferta-pegar" data-id="${c.id}">Pegar contato</button>`;
    }
    return `
      <tr>
        <td><strong>${c.nome}</strong></td>
        <td>${c.telefone}</td>
        <td>${c.email || '—'}</td>
        <td><span class="status-pill ${st.classe}">${st.texto}</span></td>
        <td>${botao}</td>
      </tr>
    `;
  }).join('');
}

$('#ofertaAtivaSearch').addEventListener('input', renderOfertaAtivaTable);

$('#ofertaAtivaAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('#oa-nome').value.trim();
  const telefone = $('#oa-telefone').value.trim();
  const email = $('#oa-email').value.trim();
  if (!nome || !telefone) return;
  const { error } = await supabase.from('contatos_oferta_ativa').insert({ nome, telefone, email: email || null });
  if (error) { toast('Não foi possível adicionar o contato.', true); console.error(error); return; }
  $('#ofertaAtivaAddForm').reset();
  toast('Contato adicionado à fila.');
  loadOfertaAtiva();
});

$('#ofertaAtivaImportBtn').addEventListener('click', async () => {
  const texto = $('#ofertaAtivaImportText').value;
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return;
  const registros = linhas.map((linha) => {
    const [nome, telefone, email] = linha.split(';').map((p) => (p || '').trim());
    return { nome, telefone, email: email || null };
  }).filter((r) => r.nome && r.telefone);
  if (!registros.length) { toast('Nenhuma linha válida encontrada (use nome;telefone;email).', true); return; }
  const { error } = await supabase.from('contatos_oferta_ativa').insert(registros);
  if (error) { toast('Não foi possível importar a lista.', true); console.error(error); return; }
  $('#ofertaAtivaImportText').value = '';
  toast(`${registros.length} contato(s) importado(s).`);
  loadOfertaAtiva();
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'oferta-pegar') {
    const id = e.target.dataset.id;
    e.target.disabled = true;
    const { data, error } = await supabase.rpc('oferta_ativa_pegar_contato', { p_contato_id: id });
    if (error) { toast('Erro ao pegar contato.', true); console.error(error); loadOfertaAtiva(); return; }
    const resultado = Array.isArray(data) ? data[0] : data;
    if (!resultado?.sucesso) { toast(resultado?.mensagem || 'Não foi possível pegar este contato.', true); loadOfertaAtiva(); return; }
    toast(resultado.mensagem || 'Contato atribuído! Complete o cadastro em Leads.');
    loadOfertaAtiva();
    return;
  }

  if (e.target.dataset.action === 'oferta-devolver') {
    const id = e.target.dataset.id;
    if (!confirm('Devolver este contato para a fila? Ele fica disponível para qualquer corretor imediatamente.')) return;
    e.target.disabled = true;
    const { data, error } = await supabase.rpc('oferta_ativa_devolver_contato', { p_contato_id: id });
    if (error) { toast('Erro ao devolver contato.', true); console.error(error); loadOfertaAtiva(); return; }
    const resultado = Array.isArray(data) ? data[0] : data;
    if (!resultado?.sucesso) { toast(resultado?.mensagem || 'Não foi possível devolver este contato.', true); loadOfertaAtiva(); return; }
    toast(resultado.mensagem || 'Contato devolvido para a fila.');
    loadOfertaAtiva();
    return;
  }
});

// =====================================================================
// FUNIL DE VENDAS (KANBAN) — acompanhamento do lead até a assinatura
// =====================================================================
const FUNIL_COLUNAS = LEAD_STATUSES.map((status) => ({ status, label: LEAD_STATUS_LABELS[status] }));

let funilCorretorFiltro = '';
let funilCorretoresCarregados = false;
let funilLeadsCache = [];
let funilBusca = '';

async function loadFunil() {
  const wrap = $('#funilFiltroCorretorWrap');
  wrap.hidden = !podeVerFinanceiro;

  if (podeVerFinanceiro && !funilCorretoresCarregados) {
    const { data: corretores } = await supabase.from('usuarios').select('id,nome').order('nome');
    const select = $('#funilFiltroCorretor');
    (corretores || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nome;
      select.appendChild(opt);
    });
    funilCorretoresCarregados = true;
  }

  let query = supabase.from('leads').select('*, usuarios(id,nome)')
    .order('atualizado_em', { ascending: false, nullsFirst: false })
    .order('criado_em', { ascending: false });
  if (podeVerFinanceiro) {
    if (funilCorretorFiltro) query = query.eq('corretor_id', funilCorretorFiltro);
  } else if (currentUsuario) {
    query = query.eq('corretor_id', currentUsuario.id);
  }

  const { data, error } = await query;
  const board = $('#kanbanBoard');
  if (error) { board.innerHTML = '<p class="table-empty">Erro ao carregar o funil.</p>'; console.error(error); return; }

  funilLeadsCache = data || [];
  renderFunilBoard();
}

// Filtra e desenha o quadro a partir do cache já carregado — usado tanto pelo
// loadFunil (após buscar do banco) quanto pela busca por nome/telefone (sem
// precisar recarregar do servidor a cada letra digitada).
function renderFunilBoard() {
  const board = $('#kanbanBoard');
  const termo = semAcento((funilBusca || '').trim());
  const leads = termo
    ? funilLeadsCache.filter((l) => semAcento([l.nome, l.telefone].filter(Boolean).join(' ')).includes(termo))
    : funilLeadsCache;

  if (termo && !leads.length) {
    board.innerHTML = '<p class="table-empty">Nenhum lead encontrado para essa busca.</p>';
    return;
  }

  board.innerHTML = FUNIL_COLUNAS.map((col) => {
    const doColuna = leads.filter((l) => l.status === col.status);
    // Com busca ativa, some a coluna sem resultado — sobra só onde o lead procurado está,
    // em vez de ele ficar perdido numa coluna com centenas de cards (ex.: "1ª Tentativa").
    if (termo && !doColuna.length) return '';
    return `
      <div class="kanban-col">
        <div class="kanban-col-head"><span>${col.label}</span><span class="kanban-col-count">${doColuna.length}</span></div>
        <div class="kanban-cards">
          ${doColuna.length ? doColuna.map((l) => `
            <div class="kanban-card">
              ${nomeLeadEditavelHtml(l)}
              <small>${l.telefone || ''}</small>
              <small>${l.interesse || 'interesse não informado'}</small>
              ${podeVerFinanceiro ? `<span class="kanban-card-corretor">${l.usuarios?.nome || 'Sem corretor'}</span>` : ''}
              <button type="button" class="btn btn-ghost btn-sm kanban-card-historico" data-action="lead-view" data-id="${l.id}">💬 Ver histórico</button>
              <select class="status-select" data-id="${l.id}" data-action="lead-status">
                ${LEAD_STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${LEAD_STATUS_LABELS[s]}</option>`).join('')}
              </select>
            </div>
          `).join('') : '<p class="kanban-empty">Nenhum lead aqui.</p>'}
        </div>
      </div>
    `;
  }).join('');
}

$('#funilBusca')?.addEventListener('input', (e) => {
  funilBusca = e.target.value;
  renderFunilBoard();
});

// =====================================================================
// FUNIL DE CAPTAÇÃO (imóveis em captação — NÃO é lead)
// =====================================================================
const CAPTACAO_ESTAGIOS = [
  { estagio: 'novo_imovel', label: 'Novo imóvel' },
  { estagio: 'contato', label: 'Contato' },
  { estagio: 'autorizacao', label: 'Autorização' },
  { estagio: 'visita', label: 'Visita' },
  { estagio: 'fotos', label: 'Fotos' },
  { estagio: 'site', label: 'Site' },
];
const CAPTACAO_PAPEIS = { incorporadora: 'Incorporadora', construtora: 'Construtora', vendedor: 'Vendedor', locador: 'Locador' };
const CAPTACAO_FINALIDADES = {
  venda_planta: 'Venda na planta',
  venda_novo: 'Venda novo',
  venda_usado: 'Venda usado',
  locacao_residencial: 'Locação residencial',
  locacao_comercial: 'Locação comercial',
};

let captacaoCorretorFiltro = '';
let captacaoCorretoresCarregados = false;
let captacoesCache = [];

async function loadCaptacao() {
  const wrap = $('#captacaoFiltroCorretorWrap');
  wrap.hidden = !podeVerFinanceiro;

  if (podeVerFinanceiro && !captacaoCorretoresCarregados) {
    const { data: corretores } = await supabase.from('usuarios').select('id,nome').order('nome');
    const select = $('#captacaoFiltroCorretor');
    (corretores || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nome;
      select.appendChild(opt);
    });
    captacaoCorretoresCarregados = true;
  }

  let query = supabase.from('captacoes').select('*, pessoas(nome,telefone), usuarios(id,nome)').order('criado_em', { ascending: false });
  if (podeVerFinanceiro) {
    if (captacaoCorretorFiltro) query = query.eq('corretor_responsavel_id', captacaoCorretorFiltro);
  } else if (currentUsuario) {
    query = query.eq('corretor_responsavel_id', currentUsuario.id);
  }

  const { data, error } = await query;
  const board = $('#kanbanBoardCaptacao');
  if (error) { board.innerHTML = '<p class="table-empty">Erro ao carregar o funil de captação.</p>'; console.error(error); return; }

  captacoesCache = data || [];
  board.innerHTML = CAPTACAO_ESTAGIOS.map((col) => {
    const doColuna = captacoesCache.filter((c) => c.estagio === col.estagio);
    return `
      <div class="kanban-col">
        <div class="kanban-col-head"><span>${col.label}</span><span class="kanban-col-count">${doColuna.length}</span></div>
        <div class="kanban-cards">
          ${doColuna.length ? doColuna.map((c) => `
            <div class="kanban-card">
              <strong>${c.titulo}</strong>
              <small>${[c.bairro, c.cidade].filter(Boolean).join(', ') || 'sem endereço'}</small>
              <small>${CAPTACAO_FINALIDADES[c.finalidade] || c.finalidade}</small>
              <small>${CAPTACAO_PAPEIS[c.papel_contato] || c.papel_contato}: ${c.pessoas?.nome || '—'}${c.pessoas?.telefone ? ' · ' + c.pessoas.telefone : ''}</small>
              ${podeVerFinanceiro ? `<span class="kanban-card-corretor">${c.usuarios?.nome || 'Sem corretor'}</span>` : ''}
              ${(c.estagio === 'fotos' || c.estagio === 'site') && !c.imovel_id ? `<button type="button" class="btn btn-primary btn-sm" data-action="captacao-criar-imovel" data-id="${c.id}">Cadastrar imóvel</button>` : ''}
              ${c.imovel_id ? '<span class="badge-oculto" style="background:rgba(22,167,102,.15);color:#16a766;">✅ Imóvel já cadastrado</span>' : ''}
              <select class="status-select" data-id="${c.id}" data-action="captacao-estagio">
                ${CAPTACAO_ESTAGIOS.map((s) => `<option value="${s.estagio}" ${s.estagio === c.estagio ? 'selected' : ''}>${s.label}</option>`).join('')}
              </select>
              ${souGerente ? `<button type="button" class="btn btn-danger btn-sm" data-action="captacao-delete" data-id="${c.id}">Excluir</button>` : ''}
            </div>
          `).join('') : '<p class="kanban-empty">Nenhuma captação aqui.</p>'}
        </div>
      </div>
    `;
  }).join('');
}

$('#captacaoFiltroCorretorWrap') && $('#captacaoFiltroCorretor')?.addEventListener('change', (e) => {
  captacaoCorretorFiltro = e.target.value;
  loadCaptacao();
});

async function captacaoForm(prefill = {}) {
  const { data: corretores } = await supabase.from('usuarios').select('id,nome,ativo').order('nome');
  const doLead = !!prefill.leadId;
  const esc = (v) => String(v || '').replace(/"/g, '&quot;');
  return `
    <h2>${doLead ? 'Enviar cliente para o Funil de Captação' : 'Nova captação'}</h2>
    ${doLead ? '<p class="modal-subtitle">O cliente do lead vira um contato de captação (vendedor, locador, construtora ou incorporadora). Preencha o imóvel e a finalidade.</p>' : ''}
    <form class="modal-form" id="captacaoForm">
      <input type="hidden" id="cap-lead-id" value="${esc(prefill.leadId)}">
      <div class="form-row full"><label>Título / imóvel (ex: Apto 3q Edifício Vitória, Casa Rua das Palmeiras)</label><input required id="cap-titulo"></div>
      <div class="form-row"><label>Nome do contato</label><input required id="cap-contato-nome" value="${esc(prefill.nome)}"></div>
      <div class="form-row"><label>Telefone do contato</label><input required id="cap-contato-telefone" value="${esc(prefill.telefone)}"></div>
      <div class="form-row"><label>Responsável (papel do contato)</label>
        <select id="cap-papel">
          ${Object.entries(CAPTACAO_PAPEIS).map(([v, l]) => `<option value="${v}" ${v === prefill.papel ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Finalidade</label>
        <select id="cap-finalidade">
          ${Object.entries(CAPTACAO_FINALIDADES).map(([v, l]) => `<option value="${v}" ${v === prefill.finalidade ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Endereço</label><input id="cap-endereco"></div>
      <div class="form-row"><label>Bairro</label><input id="cap-bairro"></div>
      <div class="form-row"><label>Cidade</label><input id="cap-cidade" value="Fazenda Rio Grande"></div>
      <div class="form-row"><label>Corretor responsável${podeVerFinanceiro ? '' : ' (você — só gerente/admin pode transferir)'}</label>
        <select id="cap-corretor" ${podeVerFinanceiro ? '' : 'disabled'}>
          ${(corretores || []).filter((c) => c.ativo !== false).map((c) => `<option value="${c.id}" ${c.id === currentUsuario?.id ? 'selected' : ''}>${c.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Observações</label><textarea id="cap-obs" rows="2">${String(prefill.obs || '').replace(/</g, '&lt;')}</textarea></div>
      <p style="grid-column:1/-1;font-size:.78rem;color:var(--gray-text);">O contato é criado (ou reaproveitado, se já existir com esse nome/telefone) automaticamente em Pessoas. Essa captação não entra no Funil de Vendas nem conta como lead.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelCaptacao">Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar captação</button>
      </div>
    </form>
  `;
}

function bindCaptacaoForm() {
  $('#cancelCaptacao').addEventListener('click', closeModal);
  $('#captacaoForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Criando...';

    const nomeContato = $('#cap-contato-nome').value.trim();
    const telefoneContato = $('#cap-contato-telefone').value.trim();
    const papel = $('#cap-papel').value;

    // Reaproveita a pessoa se já existir com o mesmo nome + telefone; senão cria.
    const foneKey = telefoneContato.replace(/\D/g, '').slice(-8);
    let pessoaId = null;
    const { data: existentes } = await supabase.from('pessoas').select('id, telefone, papeis').ilike('nome', nomeContato);
    const encontrada = (existentes || []).find((p) => (p.telefone || '').replace(/\D/g, '').slice(-8) === foneKey);

    if (encontrada) {
      pessoaId = encontrada.id;
      if (!(encontrada.papeis || []).includes(papel)) {
        await supabase.from('pessoas').update({ papeis: [...(encontrada.papeis || []), papel] }).eq('id', pessoaId);
      }
    } else {
      const { data: novaPessoa, error: erroPessoa } = await supabase.from('pessoas')
        .insert({ nome: nomeContato, telefone: telefoneContato, tipo_pessoa: 'juridica', papeis: [papel], corretor_responsavel_id: currentUsuario?.id || null })
        .select('id').single();
      if (erroPessoa) { toast('Erro ao criar o contato: ' + erroPessoa.message, true); btn.disabled = false; btn.textContent = 'Criar captação'; return; }
      pessoaId = novaPessoa.id;
    }

    const payload = {
      titulo: $('#cap-titulo').value.trim(),
      endereco: $('#cap-endereco').value.trim() || null,
      bairro: $('#cap-bairro').value.trim() || null,
      cidade: $('#cap-cidade').value.trim() || null,
      pessoa_id: pessoaId,
      papel_contato: papel,
      finalidade: $('#cap-finalidade').value,
      corretor_responsavel_id: $('#cap-corretor').value || currentUsuario?.id || null,
      observacoes: $('#cap-obs').value.trim() || null,
    };

    const { error } = await supabase.from('captacoes').insert(payload);
    if (error) { toast('Erro ao criar a captação: ' + error.message, true); btn.disabled = false; btn.textContent = 'Criar captação'; return; }

    // Veio de um lead? Deixa registrado nas observações do lead que ele foi direcionado.
    const leadId = $('#cap-lead-id')?.value;
    if (leadId) {
      const { data: leadAtual } = await supabase.from('leads').select('observacoes').eq('id', leadId).maybeSingle();
      const nota = `[${new Date().toLocaleDateString('pt-BR')}] Enviado para o Funil de Captação (${CAPTACAO_PAPEIS[papel] || papel}).`;
      await supabase.from('leads').update({ observacoes: leadAtual?.observacoes ? `${leadAtual.observacoes}\n${nota}` : nota }).eq('id', leadId);
    }

    toast(leadId ? 'Cliente enviado para o Funil de Captação.' : 'Captação criada.');
    closeModal();
    if (leadId) loadLeads(); else loadCaptacao();
  });
}

$('#newCaptacaoBtn').addEventListener('click', async () => { openModal(await captacaoForm(), { persistente: true }); bindCaptacaoForm(); });

document.addEventListener('change', async (e) => {
  if (e.target.dataset.action === 'captacao-estagio') {
    const { error } = await supabase.from('captacoes').update({ estagio: e.target.value }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar o estágio.', true); return; }
    toast('Estágio atualizado.');
    loadCaptacao();
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'captacao-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir captações.', true); return; }
    if (!confirm('Excluir esta captação? Isso não afeta o contato nem um imóvel já cadastrado a partir dela.')) return;
    const { error } = await supabase.from('captacoes').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Captação excluída.');
    loadCaptacao();
  }
  if (e.target.dataset.action === 'captacao-criar-imovel') {
    const cap = captacoesCache.find((c) => c.id === e.target.dataset.id);
    if (!cap) return;
    const mapaFinalidade = {
      venda_planta: { finalidade: 'venda', situacao: 'lancamento' },
      venda_novo: { finalidade: 'venda', situacao: 'pronto' },
      venda_usado: { finalidade: 'venda', situacao: 'pronto' },
      locacao_residencial: { finalidade: 'locacao', situacao: 'pronto' },
      locacao_comercial: { finalidade: 'locacao', situacao: 'pronto', tipo: 'comercial' },
    };
    const preenchimento = mapaFinalidade[cap.finalidade] || {};
    const rascunho = {
      titulo: cap.titulo,
      endereco: cap.endereco,
      bairro: cap.bairro,
      cidade: cap.cidade,
      finalidade: preenchimento.finalidade,
      situacao: preenchimento.situacao,
      tipo: preenchimento.tipo,
      observacoes: cap.observacoes,
      corretor_responsavel_id: cap.corretor_responsavel_id,
      proprietario_id: cap.pessoa_id,
    };
    openModal(await imovelForm(rascunho), { persistente: true });
    bindImovelForm(rascunho);
    toast('Imóvel pré-preenchido com os dados da captação. Confira e salve para publicar.');
  }
});


document.addEventListener('change', (e) => {
  if (e.target.id === 'funilFiltroCorretor') {
    funilCorretorFiltro = e.target.value;
    loadFunil();
  }
});

// =====================================================================
// IMÓVEIS
// =====================================================================
const TIPOS_IMOVEL = ['casa', 'apartamento', 'kitnet', 'terreno', 'sitio', 'fazenda', 'comercial', 'galpao', 'sala_comercial', 'area_rural', 'area_urbana'];
const STATUS_IMOVEL = ['disponivel', 'reservado', 'vendido', 'alugado', 'inativo'];

// Portais externos para os quais dá pra espelhar o imóvel via feed XML.
// Todos ficam habilitados pra seleção; por padrão, um imóvel novo só marca o Imovelweb
// (é o único portal contratado no momento — os demais o Gregório liga conforme for contratando).
const PORTAIS_XML = [
  { key: 'imovelweb', label: 'Imovelweb' },
  { key: 'chaves_na_mao', label: 'Chaves na Mão' },
  { key: 'zap', label: 'ZAP Imóveis' },
  { key: 'olx', label: 'OLX' },
  { key: 'vivareal', label: 'VivaReal' },
  { key: 'casa_mineira', label: 'Casa Mineira' },
];
let imoveisSelecionadosXML = new Set();

let imoveisCache = [];
let imoveisPagina = 1;
const TAMANHO_PAGINA = 20;

// Ordem de prioridade na fila: imóveis ativos (disponível/reservado) sempre primeiro;
// vendido/alugado/inativo vão para o final da lista, não importa a data de cadastro.
const IMOVEL_STATUS_PRIORIDADE = { disponivel: 0, reservado: 1, vendido: 2, alugado: 2, inativo: 3 };

// Nível de destaque de um imóvel, considerando um portal específico (ou o mais alto entre
// todos os portais marcados, se portalKey for vazio/"todos"). Usado no resumo e no filtro.
// Retorna 'super_destaque' | 'destaque' | 'simples' | 'sem_portal'.
function nivelParaFiltro(im, portalKey) {
  const portais = im.portais_publicacao || [];
  if (portalKey) {
    if (!portais.includes(portalKey)) return 'sem_portal';
    return nivelDestaquePortal(im, portalKey);
  }
  if (!portais.length) return 'sem_portal';
  const niveis = portais.map((k) => nivelDestaquePortal(im, k));
  if (niveis.includes('super_destaque')) return 'super_destaque';
  if (niveis.includes('destaque')) return 'destaque';
  return 'simples';
}

function popularFiltroPortal() {
  const sel = $('#imoveisFiltroPortal');
  if (!sel || sel.dataset.populado) return;
  sel.insertAdjacentHTML('beforeend', PORTAIS_XML.map((p) => `<option value="${p.key}">${p.label}</option>`).join(''));
  sel.dataset.populado = '1';
}

// Preenche o filtro "Entrega (lançamentos)" com os anos que realmente existem
// nos imóveis de lançamento cadastrados. Chamado a cada render (a lista de anos
// muda quando se cadastra/edita um lançamento).
function popularFiltroEntrega() {
  const sel = $('#imoveisFiltroEntrega');
  if (!sel) return;
  const anos = [...new Set(imoveisCache
    .filter((im) => im.situacao === 'lancamento' && im.previsao_entrega)
    .map((im) => new Date(im.previsao_entrega + 'T00:00:00').getFullYear()))]
    .sort((a, b) => a - b);
  const chaveAtual = anos.join(',');
  if (sel.dataset.anos === chaveAtual) return;
  const selecionado = sel.value;
  sel.innerHTML = '<option value="">Entrega (lançamentos)</option>'
    + '<option value="__lancamentos__">🏗️ Todos os lançamentos</option>'
    + '<option value="__sem__">Sem previsão de entrega</option>'
    + anos.map((a) => `<option value="${a}">Entrega ${a}</option>`).join('');
  sel.value = selecionado;
  if (sel.value !== selecionado) sel.value = ''; // ano some da lista -> volta pra "Todos"
  sel.dataset.anos = chaveAtual;
}

function renderResumoDestaque() {
  const el = $('#imoveisDestaqueResumo');
  if (!el || !souGestaoPortais) return;
  popularFiltroPortal();
  const portalFiltro = $('#imoveisFiltroPortal')?.value || '';
  const ativos = imoveisCache.filter((im) => im.status === 'disponivel' || im.status === 'reservado');
  const contagem = { super_destaque: 0, destaque: 0, simples: 0, sem_portal: 0 };
  ativos.forEach((im) => { contagem[nivelParaFiltro(im, portalFiltro)]++; });
  const chip = (nivel, label) => `<button type="button" class="destaque-chip destaque-chip-${nivel}" data-nivel="${nivel}">${label}: ${contagem[nivel]}</button>`;
  el.innerHTML = [
    chip('super_destaque', '★★ Super destaque'),
    chip('destaque', '★ Destaque'),
    chip('simples', 'Simples'),
    chip('sem_portal', portalFiltro ? 'Sem esse portal' : 'Sem portal'),
  ].join('');
  el.querySelectorAll('.destaque-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sel = $('#imoveisFiltroDestaque');
      sel.value = sel.value === btn.dataset.nivel ? '' : btn.dataset.nivel;
      imoveisPagina = 1;
      renderImoveisTable();
    });
  });
}

async function loadImoveis() {
  const wrap = $('#imoveisCards');
  const { data, error } = await supabase
    .from('imoveis')
    .select('*, corretor:usuarios!corretor_responsavel_id(id,nome)')
    .order('criado_em', { ascending: false });
  if (error) { wrap.innerHTML = `<p class="empty-state">Erro ao carregar imóveis.</p>`; console.error(error); return; }
  imoveisCache = (data || []).slice().sort((a, b) => {
    const pa = IMOVEL_STATUS_PRIORIDADE[a.status] ?? 1.5;
    const pb = IMOVEL_STATUS_PRIORIDADE[b.status] ?? 1.5;
    if (pa !== pb) return pa - pb;
    return new Date(b.criado_em) - new Date(a.criado_em);
  });
  imoveisPagina = 1;
  renderImoveisTable();
}

function renderImoveisTable() {
  const wrap = $('#imoveisCards');
  renderResumoDestaque();
  popularFiltroEntrega();
  const termo = semAcento(($('#imoveisSearch')?.value || '').trim());
  const tipoFiltro = $('#imoveisFiltroTipo')?.value || '';
  const portalFiltro = $('#imoveisFiltroPortal')?.value || '';
  const nivelFiltro = $('#imoveisFiltroDestaque')?.value || '';
  const entregaFiltro = $('#imoveisFiltroEntrega')?.value || '';
  $$('.destaque-chip').forEach((btn) => btn.classList.toggle('is-ativo', nivelFiltro === btn.dataset.nivel));

  let filtrados = termo
    ? imoveisCache.filter((im) => bateBuscaPorPalavras(termo, [im.titulo, im.codigo, im.bairro, im.corretor?.nome].filter(Boolean).join(' ')))
    : imoveisCache;
  if (tipoFiltro) filtrados = filtrados.filter((im) => im.tipo === tipoFiltro);
  if (nivelFiltro) filtrados = filtrados.filter((im) => nivelParaFiltro(im, portalFiltro) === nivelFiltro);
  if (entregaFiltro === '__lancamentos__') filtrados = filtrados.filter((im) => im.situacao === 'lancamento');
  else if (entregaFiltro === '__sem__') filtrados = filtrados.filter((im) => im.situacao === 'lancamento' && !im.previsao_entrega);
  else if (entregaFiltro) filtrados = filtrados.filter((im) => im.situacao === 'lancamento' && im.previsao_entrega && String(new Date(im.previsao_entrega + 'T00:00:00').getFullYear()) === entregaFiltro);
  if (filtroImoveisSemFoto) {
    filtrados = filtrados.filter((im) => im.status === 'disponivel' && (!im.fotos || im.fotos.length === 0));
  }
  if (filtroImoveisFeed) {
    filtrados = filtrados.filter((im) => idsImoveisFeedProblema.includes(im.id));
  }

  const bannerFotos = $('#imoveisAlertaBanner');
  if (bannerFotos) {
    bannerFotos.hidden = !filtroImoveisSemFoto && !filtroImoveisFeed;
    if (filtroImoveisSemFoto) {
      bannerFotos.innerHTML = `<span>🔔 Mostrando <strong>${filtrados.length}</strong> imóve${filtrados.length === 1 ? 'l' : 'is'} disponíve${filtrados.length === 1 ? 'l' : 'is'} sem foto.</span><button type="button" class="btn btn-ghost btn-sm" data-action="limpar-filtro-alerta" data-tela="imoveis">Limpar filtro</button>`;
    } else if (filtroImoveisFeed) {
      bannerFotos.innerHTML = `<span>🔔 Mostrando <strong>${filtrados.length}</strong> imóve${filtrados.length === 1 ? 'l' : 'is'} com problema no feed do Imovelweb.</span><button type="button" class="btn btn-ghost btn-sm" data-action="limpar-filtro-alerta" data-tela="imoveis">Limpar filtro</button>`;
    }
  }

  if (!filtrados.length) { wrap.innerHTML = `<p class="empty-state">${filtroImoveisSemFoto ? 'Nenhum imóvel sem foto — tudo corrigido! 🎉' : filtroImoveisFeed ? 'Nenhum imóvel com problema no feed — tudo corrigido! 🎉' : (imoveisCache.length ? 'Nenhum imóvel encontrado para esse filtro.' : 'Nenhum imóvel cadastrado ainda.')}</p>`; atualizarToolbarXML(); return; }

  const visiveis = filtrados.slice(0, imoveisPagina * TAMANHO_PAGINA);
  const podeExcluir = souGerente; // exclusão restrita ao gerente (regra também garantida pelo banco via RLS)

  wrap.innerHTML = visiveis.map((im) => {
    const foto = firstFoto(im.fotos);
    const enderecoLinha = [[im.endereco, im.numero].filter(Boolean).join(', '), im.bairro, im.cidade].filter(Boolean).join(' — ');

    let preco;
    if (im.finalidade === 'venda_locacao') preco = `${money(im.valor_venda)} <span class="imovel-card-preco-sep">·</span> ${money(im.valor_locacao)}/mês`;
    else if (im.finalidade === 'locacao') preco = `${money(im.valor_locacao)}/mês`;
    else preco = money(im.valor_venda);

    const badges = [];
    if (im.quartos) badges.push(`${im.quartos} dorm.`);
    if (im.vagas_garagem) badges.push(`${im.vagas_garagem} vaga${im.vagas_garagem > 1 ? 's' : ''}`);
    if (im.area_construida) badges.push(`Construído: ${Number(im.area_construida).toLocaleString('pt-BR')} m²`);
    else if (im.area_total) badges.push(`Área: ${Number(im.area_total).toLocaleString('pt-BR')} m²`);
    if (im.situacao === 'lancamento') {
      const FASE_OBRA_LABEL = { breve_lancamento: 'Breve lançamento', em_obras: 'Em obras', entregue: 'Entregue' };
      if (im.previsao_entrega) badges.push(`🗓️ Entrega ${new Date(im.previsao_entrega + 'T00:00:00').getFullYear()}`);
      else if (im.fase_obra) badges.push(`🏗️ ${FASE_OBRA_LABEL[im.fase_obra] || im.fase_obra}`);
      else badges.push('🗓️ Entrega a definir');
    }

    const acoesStatus = (im.status === 'disponivel' || im.status === 'reservado') ? `
        ${im.finalidade !== 'locacao' ? `<button class="btn btn-ghost btn-sm" data-action="imovel-marcar-vendido" data-id="${im.id}">Marcar vendido</button>` : ''}
        ${im.finalidade !== 'venda' ? `<button class="btn btn-ghost btn-sm" data-action="imovel-marcar-alugado" data-id="${im.id}">Marcar alugado</button>` : ''}
      ` : '';

    return `
      <article class="imovel-card">
        <div class="imovel-card-photo">
          ${souGestaoPortais ? `<label class="imovel-card-select" title="Selecionar para gerar XML"><input type="checkbox" class="imovel-xml-check" data-id="${im.id}" ${imoveisSelecionadosXML.has(im.id) ? 'checked' : ''}></label>` : ''}
          ${foto ? `<img src="${foto}" alt="">` : '<span class="imovel-card-photo-vazia">🏠</span>'}
          ${im.destaque ? '<span class="imovel-card-flag">★ Destaque</span>' : ''}
        </div>
        <div class="imovel-card-body">
          <div class="imovel-card-top">
            <div class="imovel-card-heading">
              <span class="imovel-card-codigo">${destacarBusca(termo, im.codigo || 'sem código')} · ${im.tipo}${im.situacao === 'lancamento' ? ' · 🏗️ Lançamento' : ''}</span>
              <h3 class="imovel-card-titulo">${destacarBusca(termo, im.titulo)}</h3>
              <p class="imovel-card-loc">${destacarBusca(termo, enderecoLinha || 'Endereço não informado')}</p>
            </div>
            ${statusPill(im.status, im.motivo_desativacao)}
          </div>
          ${badges.length ? `<div class="imovel-card-badges">${badges.map((b) => `<span class="badge-mini">${b}</span>`).join('')}</div>` : ''}
          ${filtroImoveisFeed && motivosImoveisFeedProblema.has(im.id) ? `
          <div class="imovel-card-feed-problema">
            ${motivosImoveisFeedProblema.get(im.id).map((m) => `<span class="badge-mini badge-feed-${m.bloqueia ? 'bloqueia' : 'atencao'}" title="${m.bloqueia ? 'Impede a entrada no feed' : 'Entra no feed, mas com qualidade fraca'}">${m.bloqueia ? '⛔' : '⚠️'} ${m.texto}</span>`).join('')}
          </div>` : ''}
          <div class="imovel-card-footer">
            <div class="imovel-card-precowrap">
              <strong class="imovel-card-preco">${preco}</strong>
              <span class="imovel-card-meta">${im.corretor?.nome || 'Sem corretor'} · ${im.visualizacoes ?? 0} views · ${im.publicado ? 'Publicado' : 'Não publicado'}${(im.portais_publicacao || []).length ? ` · 🌐 ${im.portais_publicacao.map((k) => {
                const label = PORTAIS_XML.find((p) => p.key === k)?.label || k;
                const nivel = nivelDestaquePortal(im, k);
                const sufixo = nivel === 'super_destaque' ? ' ★★' : (nivel === 'destaque' ? ' ★' : '');
                return `${label}${sufixo}`;
              }).join(', ')}` : ''}</span>
            </div>
            <div class="imovel-card-actions">
              <button class="btn btn-ghost btn-sm" data-action="imovel-edit" data-id="${im.id}">Editar</button>
              <button class="btn btn-ghost btn-sm" data-action="imovel-duplicar" data-id="${im.id}">Duplicar</button>
              ${acoesStatus}
              ${im.status === 'inativo'
                ? `<button class="btn btn-ghost btn-sm" data-action="imovel-ativar" data-id="${im.id}">Ativar</button>`
                : `<button class="btn btn-ghost btn-sm" data-action="imovel-desativar" data-id="${im.id}">Desativar</button>`}
              ${im.status !== 'inativo' ? `<button class="btn btn-ghost btn-sm" data-action="imovel-copiar-link" data-id="${im.id}">🔗 Copiar link</button>` : ''}
              <button class="btn btn-ghost btn-sm" data-action="imovel-ficha-pdf" data-id="${im.id}">Ficha PDF</button>
              ${(im.fotos || []).length ? `<button class="btn btn-ghost btn-sm" data-action="imovel-baixar-fotos" data-id="${im.id}">Baixar fotos (.zip)</button>` : ''}
              ${podeExcluir ? `<button class="btn btn-danger btn-sm" data-action="imovel-delete" data-id="${im.id}">Excluir</button>` : ''}
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');

  if (filtrados.length > visiveis.length) {
    wrap.innerHTML += `<div class="imoveis-cards-more"><button class="btn btn-ghost btn-sm" id="imoveisCarregarMais">Carregar mais (${filtrados.length - visiveis.length} restantes)</button></div>`;
    $('#imoveisCarregarMais').addEventListener('click', () => { imoveisPagina += 1; renderImoveisTable(); });
  }
  atualizarToolbarXML();
}

$('#imoveisSearch').addEventListener('input', () => { imoveisPagina = 1; renderImoveisTable(); });
$('#imoveisFiltroTipo').addEventListener('change', () => { imoveisPagina = 1; renderImoveisTable(); });
$('#imoveisFiltroDestaque').addEventListener('change', () => { imoveisPagina = 1; renderImoveisTable(); });
$('#imoveisFiltroPortal').addEventListener('change', () => { imoveisPagina = 1; renderImoveisTable(); });
$('#imoveisFiltroEntrega')?.addEventListener('change', () => { imoveisPagina = 1; renderImoveisTable(); });

// Gera latitude/longitude em lote para imóveis que já têm CEP mas ainda não têm coordenadas.
// A geocodificação em si roda na Edge Function "geocodificar-endereco" (Nominatim/OSM não libera
// CORS pra chamada direta do navegador). Roda sequencial, uma chamada por vez, pra não sobrecarregar
// a API gratuita.
$('#imoveisGeocodificarBtn')?.addEventListener('click', async () => {
  const btn = $('#imoveisGeocodificarBtn');
  const { data: pendentes, error } = await supabase
    .from('imoveis')
    .select('id, cep, endereco, numero, bairro, cidade')
    .not('cep', 'is', null)
    .neq('cep', '')
    .or('latitude.is.null,longitude.is.null');

  if (error) { toast('Erro ao buscar imóveis: ' + error.message, true); return; }
  if (!pendentes.length) { toast('Todos os imóveis com CEP já têm coordenadas. 🎉'); return; }

  if (!confirm(`Gerar coordenadas para ${pendentes.length} imóve${pendentes.length === 1 ? 'l' : 'is'}? Leva alguns segundos, um de cada vez.`)) return;

  btn.disabled = true;
  const textoOriginal = btn.textContent;
  let exatos = 0;
  let aproximados = 0;
  let falha = 0;

  for (let i = 0; i < pendentes.length; i++) {
    const im = pendentes[i];
    btn.textContent = `📍 Geocodificando ${i + 1}/${pendentes.length}...`;
    try {
      const { data: resultado, error: erroFn } = await supabase.functions.invoke('geocodificar-endereco', {
        body: { cep: im.cep, endereco: im.endereco, numero: im.numero, bairro: im.bairro, cidade: im.cidade },
      });
      if (erroFn || !resultado?.encontrado) {
        falha++;
      } else {
        await supabase.from('imoveis').update({ latitude: resultado.latitude, longitude: resultado.longitude }).eq('id', im.id);
        if (resultado.precisao === 'endereco' || resultado.precisao === 'endereco_viacep') exatos++;
        else aproximados++;
      }
    } catch {
      falha++;
    }
  }

  btn.disabled = false;
  btn.textContent = textoOriginal;
  const partes = [];
  if (exatos) partes.push(`${exatos} no endereço exato`);
  if (aproximados) partes.push(`${aproximados} aproximado${aproximados === 1 ? '' : 's'} (bairro/cidade)`);
  if (falha) partes.push(`${falha} não encontrado${falha === 1 ? '' : 's'}`);
  toast(`Coordenadas geradas: ${partes.join(', ')}.`, falha > 0 && exatos === 0 && aproximados === 0);
  loadImoveis();
});

// =====================================================================
// SELEÇÃO E EXPORTAÇÃO DE XML PARA PORTAIS
// =====================================================================
function atualizarToolbarXML() {
  const n = imoveisSelecionadosXML.size;
  const contagem = $('#imoveisXmlContagem');
  const btnGerar = $('#imoveisXmlGerarBtn');
  if (contagem) contagem.textContent = n ? `${n} imóvel${n > 1 ? 'is' : ''} selecionado${n > 1 ? 's' : ''}` : 'Nenhum imóvel selecionado';
  if (btnGerar) btnGerar.disabled = n === 0;
}

document.addEventListener('change', (e) => {
  if (!e.target.classList.contains('imovel-xml-check')) return;
  const id = e.target.dataset.id;
  if (e.target.checked) imoveisSelecionadosXML.add(id); else imoveisSelecionadosXML.delete(id);
  atualizarToolbarXML();
});

$('#imoveisXmlSelecionarTodos')?.addEventListener('click', () => {
  const termo = semAcento(($('#imoveisSearch')?.value || '').trim());
  const filtrados = termo
    ? imoveisCache.filter((im) => bateBuscaPorPalavras(termo, [im.titulo, im.codigo, im.bairro, im.corretor?.nome].filter(Boolean).join(' ')))
    : imoveisCache;
  filtrados.forEach((im) => imoveisSelecionadosXML.add(im.id));
  renderImoveisTable();
  toast(`${filtrados.length} imóvel(is) selecionado(s).`);
});

$('#imoveisXmlLimpar')?.addEventListener('click', () => {
  imoveisSelecionadosXML.clear();
  renderImoveisTable();
});

$('#imoveisXmlGerarBtn')?.addEventListener('click', () => {
  if (!imoveisSelecionadosXML.size) return;
  openModal(gerarXmlPortalForm(), { persistente: false });
  $('#cancelGerarXml').addEventListener('click', closeModal);
  $('#gerarXmlForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const portal = $('#gx-portal').value;
    const selecionados = imoveisCache.filter((im) => imoveisSelecionadosXML.has(im.id));
    if (!selecionados.length) { toast('Nenhum dos imóveis selecionados foi encontrado.', true); return; }
    const xml = portal === 'chaves_na_mao' ? gerarXmlChavesNaMao(selecionados) : portal === 'imovelweb' ? gerarXmlImovelweb(selecionados) : gerarXmlGenerico(selecionados, portal);
    baixarArquivoTexto(xml, `imoveis-${portal}-${new Date().toISOString().slice(0, 10)}.xml`, 'application/xml');
    toast(`XML gerado com ${selecionados.length} imóvel(is) para ${PORTAIS_XML.find((p) => p.key === portal)?.label || portal}.`);
    closeModal();
  });
});

function gerarXmlPortalForm() {
  const n = imoveisSelecionadosXML.size;
  return `
    <h2>Gerar XML do portal</h2>
    <form class="modal-form" id="gerarXmlForm">
      <p style="grid-column:1/-1;font-size:.85rem;color:var(--gray-text);margin:0 0 4px;">${n} imóvel${n > 1 ? 'is' : ''} selecionado${n > 1 ? 's' : ''}. Escolha o portal contratado para gerar o arquivo XML correspondente.</p>
      <div class="form-row full"><label>Portal</label>
        <select id="gx-portal">
          ${PORTAIS_XML.map((p) => `<option value="${p.key}">${p.label}</option>`).join('')}
        </select>
      </div>
      <p style="grid-column:1/-1;font-size:.75rem;color:var(--gray-text);margin:0;">O Chaves na Mão segue o layout oficial de integração do portal. Os demais (Imovelweb, ZAP, OLX, VivaReal) usam o padrão XML mais comum do mercado imobiliário brasileiro — antes de ativar em um portal novo, confirme com o suporte dele se aceita esse layout, ou peça pra eles indicarem os ajustes necessários.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelGerarXml">Cancelar</button>
        <button type="submit" class="btn btn-primary">Baixar XML</button>
      </div>
    </form>
  `;
}

function baixarArquivoTexto(conteudo, nomeArquivo, tipo) {
  const blob = new Blob([conteudo], { type: `${tipo};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nomeArquivo;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function xmlCdata(v) {
  const s = String(v ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${s}]]>`;
}
function xmlEsc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlNum(v) { return (v === null || v === undefined || v === '') ? '' : Number(v).toFixed(2); }
function xmlDataHora(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function xmlUrlImovel(im) { return `${SITE_URL_PUBLICO}/imovel/${im.id}`; }

// Link público da página do imóvel no site — mesmo formato que o site usa
// (/imovel/<slug-do-titulo>-<id>). O "?compacto=1" faz a página abrir sem o
// menu de outros produtos e sem a seção "imóveis parecidos" — fica só o
// imóvel, com a logo e um botão levando ao site completo. Serve pra enviar
// ao cliente pelo WhatsApp.
function linkPublicoImovel(im) {
  const slug = String(im.titulo || 'imovel')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'imovel';
  return `${SITE_URL_PUBLICO}/imovel/${slug}-${im.id}?compacto=1`;
}
function xmlFotosArray(im) {
  try { return Array.isArray(im.fotos) ? im.fotos : JSON.parse(im.fotos || '[]'); } catch { return []; }
}

// --- Mapeamento de tipo/finalidade para o padrão XML genérico (Imovelweb, ZAP, OLX, VivaReal) ---
const TIPO_XML_GENERICO = {
  casa: 'Casa', apartamento: 'Apartamento', terreno: 'Terreno', sitio: 'Imóvel Rural',
  fazenda: 'Imóvel Rural', comercial: 'Sala comercial', galpao: 'Galpão',
  sala_comercial: 'Sala comercial', area_rural: 'Imóvel Rural', area_urbana: 'Terreno',
};

// --- Nível de destaque do anúncio, escolhido por portal na ficha do imóvel ---
function nivelDestaquePortal(im, portalKey) {
  return (im.portais_destaque && im.portais_destaque[portalKey]) || 'simples';
}
// 0 = anúncio simples, 1 = destaque, 2 = super destaque (escala comum entre os portais que aceitam nível via XML)
function nivelDestaqueNumero(nivel) {
  if (nivel === 'super_destaque') return 2;
  if (nivel === 'destaque') return 1;
  return 0;
}

// --- Imovelweb — layout oficial OpenNavent (confirmado via XSD oficial + API sandbox em 2026-08-13) ---
// Catálogo de tipos de imóvel confirmado via GET /v1/tipopropriedade e /v1/tipopropriedade/{id}/subtipos
const MAPA_TIPO_IMOVELWEB = {
  casa: { idTipo: '1', tipo: 'Casa', idSubTipo: '5', subTipo: 'Padrão' },
  apartamento: { idTipo: '2', tipo: 'Apartamento', idSubTipo: '1', subTipo: 'Padrão' },
  kitnet: { idTipo: '2', tipo: 'Apartamento', idSubTipo: '1', subTipo: 'Padrão' },
  terreno: { idTipo: '1003', tipo: 'Terreno', idSubTipo: '8', subTipo: 'Terreno Padrão' },
  area_urbana: { idTipo: '1003', tipo: 'Terreno', idSubTipo: '8', subTipo: 'Terreno Padrão' },
  sitio: { idTipo: '1004', tipo: 'Rurais', idSubTipo: '11', subTipo: 'Sítio' },
  fazenda: { idTipo: '1004', tipo: 'Rurais', idSubTipo: '12', subTipo: 'Fazenda' },
  area_rural: { idTipo: '1004', tipo: 'Rurais', idSubTipo: '10', subTipo: 'Chácara' },
  comercial: { idTipo: '1005', tipo: 'Comercial', idSubTipo: '31', subTipo: 'Ponto Comercial' },
  galpao: { idTipo: '1005', tipo: 'Comercial', idSubTipo: '20', subTipo: 'Galpão/Depósito/Barracão' },
  sala_comercial: { idTipo: '1005', tipo: 'Comercial', idSubTipo: '16', subTipo: 'Conjunto Comercial/sala' },
};
// idLocalidade a nível BAIRRO (V1-D) — pedido da Rosana/Imovelweb pra melhorar o Quality Score.
// Mapeado via GET /v1/ubicaciones/{idCidade} em 2026-08-13. Cidade cai pro nível CIDADE (V1-C)
// se o bairro não constar no catálogo deles (fallback seguro, nunca quebra o envio).
const LOCALIDADES_IMOVELWEB = {
  'fazenda rio grande': {
    cidadeId: 'V1-C-106068',
    bairros: {
      'centro': 'V1-D-499749', 'dom bosco': 'V1-D-494526', 'estados': 'V1-D-552417',
      'eucaliptos': 'V1-D-552418', 'gralha azul': 'V1-D-552419', 'iguacu': 'V1-D-552420',
      'iguacu ii': 'V1-D-494073', 'jardim canaa': 'V1-D-493778', 'jardim colonial': 'V1-D-495024',
      'jardim eucaliptos': 'V1-D-493146', 'jardim imaculada conceicao': 'V1-D-494525',
      'jardim ipe': 'V1-D-494955', 'jardim das hortencias': 'V1-D-493777', 'nacoes': 'V1-D-552421',
      'palmeiras': 'V1-D-492894', 'parque verde': 'V1-D-493352', 'passo amarelo': 'V1-D-495023',
      'pioneiros': 'V1-D-532858', 'patria minha': 'V1-D-493351', 'santa fe': 'V1-D-494524',
      'santa maria': 'V1-D-494667', 'santa terezinha': 'V1-D-552422', 'santarem': 'V1-D-491505',
      'sao sebastiao': 'V1-D-555994', 'sitio cercado': 'V1-D-494523', 'veneza': 'V1-D-552423',
      'vera cruz': 'V1-D-494522', 'vila carelli': 'V1-D-494521', 'vista alegre': 'V1-D-494520',
      'area rural de fazenda rio grande': 'V1-D-1557932',
    },
  },
  curitiba: {
    cidadeId: 'V1-C-106015',
    bairros: {
      'abranches': 'V1-D-508617', 'ahu': 'V1-D-508619', 'alphaville': 'V1-D-499051', 'alto boqueirao': 'V1-D-508620', 'alto da gloria': 'V1-D-508621', 'alto da xv': 'V1-D-508622', 'atuba': 'V1-D-508623', 'augusta': 'V1-D-508624', 'bacacheri': 'V1-D-508625', 'bairro alto': 'V1-D-508626', 'bairro novo': 'V1-D-499317', 'barigui': 'V1-D-499639', 'barreirinha': 'V1-D-508627', 'batel': 'V1-D-508628', 'bigorrilho': 'V1-D-508629', 'boa vista': 'V1-D-508630', 'bom retiro': 'V1-D-508631', 'boqueirao': 'V1-D-508632', 'butiatuvinha': 'V1-D-508633', 'cic': 'V1-D-499085', 'cabral': 'V1-D-508634', 'cachoeira': 'V1-D-508635', 'caiua': 'V1-D-495388', 'cajuru': 'V1-D-508636', 'campina do siqueira': 'V1-D-508637', 'campo comprido': 'V1-D-508638', 'campo de santana': 'V1-D-508639', 'capao raso': 'V1-D-508642', 'capao da imbuia': 'V1-D-508641', 'cascatinha': 'V1-D-508643', 'caximba': 'V1-D-508644', 'centro': 'V1-D-508645', 'centro civico': 'V1-D-508646', 'champagnat': 'V1-D-499989', 'cidade industrial': 'V1-D-508647', 'cotolengo': 'V1-D-499084', 'cristo rei': 'V1-D-508648', 'ecoville': 'V1-D-499990', 'eucalipto': 'V1-D-494945', 'fanny': 'V1-D-508649', 'fazendinha': 'V1-D-508650', 'ganchinho': 'V1-D-508651', 'guabirotuba': 'V1-D-508652', 'guaira': 'V1-D-508653', 'hauer': 'V1-D-508654', 'higienopolis': 'V1-D-494956', 'hugo lange': 'V1-D-508655', 'itatiaia': 'V1-D-492330', 'jardim botanico': 'V1-D-508656', 'jardim gabineto': 'V1-D-491613', 'jardim los angeles': 'V1-D-494030', 'jardim mercurio': 'V1-D-494668', 'jardim querencia': 'V1-D-494583', 'jardim santa monica': 'V1-D-494852', 'jardim schaffer': 'V1-D-498984', 'jardim social': 'V1-D-508658', 'jardim das americas': 'V1-D-508657', 'juveve': 'V1-D-508659', 'lamenha pequena': 'V1-D-508660', 'lindoia': 'V1-D-508661', 'merces': 'V1-D-508662', 'mossungue': 'V1-D-508663', 'neoville': 'V1-D-498965', 'novo mundo': 'V1-D-508664', 'orleans': 'V1-D-508665', 'osternack': 'V1-D-493981', 'parolin': 'V1-D-508666', 'parque tangua': 'V1-D-495346', 'passauna': 'V1-D-495041', 'pilarzinho': 'V1-D-508667', 'pinhais': 'V1-D-495501', 'pinheirinho': 'V1-D-508668', 'portao': 'V1-D-508669', 'prado velho': 'V1-D-508670', 'praia de leste': 'V1-D-495403', 'reboucas': 'V1-D-508671', 'riviera': 'V1-D-508672', 'santa candida': 'V1-D-508673', 'santa felicidade': 'V1-D-508674', 'santa quiteria': 'V1-D-508675', 'santo inacio': 'V1-D-508676', 'seminario': 'V1-D-508682', 'sitio cercado': 'V1-D-556684', 'sao braz': 'V1-D-508677', 'sao francisco': 'V1-D-508678', 'sao joao': 'V1-D-508679', 'sao lourenco': 'V1-D-508680', 'sao miguel': 'V1-D-508681', 'sitio cercado vila rio negro': 'V1-D-493354', 'taboao': 'V1-D-508684', 'taruma': 'V1-D-508685', 'tatuquara': 'V1-D-508686', 'tingui': 'V1-D-508687', 'uberaba': 'V1-D-508688', 'umbara': 'V1-D-508689', 'vila camargo': 'V1-D-494733', 'vila izabel': 'V1-D-508690', 'vila oficinas': 'V1-D-494479', 'vila sandra': 'V1-D-494037', 'vila sao pedro': 'V1-D-498983', 'vista alegre': 'V1-D-508691', 'vitoria regia': 'V1-D-499291', 'xaxim': 'V1-D-508692', 'agua verde': 'V1-D-508618'
    },
  },
  quitandinha: {
    cidadeId: 'V1-C-106509',
    bairros: {
      'campina de quitandinha': 'V1-D-548802', centro: 'V1-D-532693', 'cerro verde': 'V1-D-548803',
      'doce fino': 'V1-D-548805', 'lagoa verde': 'V1-D-548800', pangare: 'V1-D-493035',
      'ribeirao vermelho': 'V1-D-548806', 'sao joao caiva': 'V1-D-495391', turvo: 'V1-D-548807',
    },
  },
};
const IDLOCALIDADE_IMOVELWEB = LOCALIDADES_IMOVELWEB['fazenda rio grande'].cidadeId; // fallback padrão

function normalizarTextoImovelweb(v) {
  return (v || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}
function resolverIdLocalidadeImovelweb(cidade, bairro) {
  const cidadeInfo = LOCALIDADES_IMOVELWEB[normalizarTextoImovelweb(cidade)];
  if (!cidadeInfo) return IDLOCALIDADE_IMOVELWEB;
  // "teresinha" é grafia comum digitada pelos corretores; o catálogo oficial usa "terezinha"
  const bairroNorm = normalizarTextoImovelweb(bairro).replace(/teresinha/g, 'terezinha');
  if (bairroNorm && cidadeInfo.bairros[bairroNorm]) return cidadeInfo.bairros[bairroNorm];
  // fallback por aproximação (ex.: "Jardim Veneza" -> catálogo tem só "Veneza")
  if (bairroNorm) {
    const chaveAprox = Object.keys(cidadeInfo.bairros).find((k) => bairroNorm.includes(k) || k.includes(bairroNorm));
    if (chaveAprox) return cidadeInfo.bairros[chaveAprox];
  }
  return cidadeInfo.cidadeId; // bairro não catalogado — cai pro nível cidade
}

// tipoPublicacao: mapeia nível de destaque do CRM pro valor aceito pela Imovelweb
const TIPO_PUBLICACAO_IMOVELWEB = { super_destaque: 'HOME', destaque: 'DESTACADO', simples: 'SIMPLE' };
// Dados do publicador — vindos de config_site (mesmos usados no rodapé/WhatsApp do site público)
const PUBLICADOR_IMOVELWEB = {
  codigoImobiliaria: 'PENDENTE_PRODUCAO', // Imovelweb atribui isso só quando a integração for liberada em produção — Rosana vai passar
  emailContato: 'imobiliariagregorio@gmail.com',
  nomeContato: 'Gregório | Meu Lar Imobiliária',
  telefoneContato: '(41) 99547-6193',
};

// Comodidades (características booleanas do catálogo Imovelweb, IDs confirmados via
// GET /v1/tipopropiedades/{id}/caracteristicas) mapeadas a partir do texto livre que os
// corretores já digitam no campo "Características" do imóvel no CRM.
const REGRAS_CARACTERISTICAS_EXTRAS_IMOVELWEB = [
  [['piscina'], '20140'],
  [['churrasqueira', 'churraqueira'], '20048'],
  [['ar-condicionado', 'ar condicionado', 'climatiza'], '20012'],
  [['espaco pet', 'pet place', 'pet spa', 'aceita pet', 'permite animais', 'permite pet'], '20135'],
  [['espaco gourmet', 'gourmet'], '20080'],
  [['despensa'], '20065'],
  [['sistema de alarme', 'alarme'], '20184'],
  [['quarto de servico'], '20062'],
  [['varanda', 'sacada'], '20199'],
  [['elevador'], '20071'],
  [['sauna'], '10183'],
  [['salao de festas'], '10181'],
];
function caracteristicasExtrasImovelweb(im) {
  const texto = normalizarTextoImovelweb([im.descricao, im.pontos_fortes, (im.caracteristicas || []).join(' | ')].filter(Boolean).join(' | '));
  const ids = [];
  REGRAS_CARACTERISTICAS_EXTRAS_IMOVELWEB.forEach(([palavras, id]) => {
    if (palavras.some((p) => texto.includes(p))) ids.push(id);
  });
  if (im.aceita_permuta) ids.push('10088');
  return ids;
}

function xmlOpenNaventTag(tag, valor) { return `<${tag}><![CDATA[${valor === null || valor === undefined ? '' : valor}]]></${tag}>`; }
function xmlCaracteristicaImovelweb(id, opts) {
  return `<caracteristica>${xmlOpenNaventTag('id', id)}${opts.valor !== undefined ? xmlOpenNaventTag('valor', opts.valor) : ''}${opts.idValor !== undefined ? xmlOpenNaventTag('idValor', opts.idValor) : ''}</caracteristica>`;
}


function gerarXmlImovelweb(imoveisSelecionados) {
  const semFotosSuficientes = [];
  const lancamentosIgnorados = [];
  const blocos = [];

  imoveisSelecionados.forEach((im) => {
    // 2026-08-25: Imovelweb abriu uma exceção e passou a aceitar lançamentos de Curitiba
    // como classificado normal (<Imovel>). Lançamentos de outras cidades continuam de fora
    // (regra do Gregório: só lançamento de Curitiba pode ir pro Imovelweb).
    if (im.situacao === 'lancamento' && normalizarTextoImovelweb(im.cidade) !== 'curitiba') { lancamentosIgnorados.push(im.codigo || im.titulo || im.id); return; }
    const fotos = xmlFotosArray(im);
    if (fotos.length < 5) { semFotosSuficientes.push(im.codigo || im.titulo || im.id); return; }

    const mapaTipo = MAPA_TIPO_IMOVELWEB[im.tipo] || MAPA_TIPO_IMOVELWEB.casa;
    const nivel = nivelDestaquePortal(im, 'imovelweb');

    // descricao exige 50-10000 caracteres — completa com pontos fortes se for curta
    let descricao = [im.descricao, im.pontos_fortes].filter(Boolean).join('\n\n').trim();
    if (descricao.length < 50) descricao = `${descricao} Imóvel disponível através da Gregório | Meu Lar Imobiliária, em Fazenda Rio Grande - PR. Entre em contato para mais informações e agendamento de visita.`.trim();
    descricao = descricao.slice(0, 10000);

    const titulo = (im.titulo || `${mapaTipo.tipo} em Fazenda Rio Grande`).slice(0, 80);
    const endereco = [im.endereco, im.numero].filter(Boolean).join(', ').slice(0, 200) || 'Endereço a confirmar';

    // Características — numéricas (IDs confirmados via API, estáveis entre tipos)
    const caractsXml = [];
    if (im.quartos) caractsXml.push(xmlCaracteristicaImovelweb('CFT2', { valor: im.quartos }));
    if (im.banheiros) caractsXml.push(xmlCaracteristicaImovelweb('CFT3', { valor: im.banheiros }));
    if (im.suites) caractsXml.push(xmlCaracteristicaImovelweb('CFT4', { valor: im.suites }));
    if (im.vagas_garagem) caractsXml.push(xmlCaracteristicaImovelweb('CFT7', { valor: im.vagas_garagem }));
    if (im.area_total) caractsXml.push(xmlCaracteristicaImovelweb('CFT100', { valor: im.area_total }));
    if (im.area_construida) caractsXml.push(xmlCaracteristicaImovelweb('CFT101', { valor: im.area_construida }));
    if (im.valor_condominio) caractsXml.push(xmlCaracteristicaImovelweb('CFT6', { valor: im.valor_condominio }));
    if (im.valor_iptu) caractsXml.push(xmlCaracteristicaImovelweb('CFT400', { valor: im.valor_iptu }));
    if (im.ano_construcao) caractsXml.push(xmlCaracteristicaImovelweb('CFT5', { valor: Math.max(0, new Date().getFullYear() - im.ano_construcao) }));
    if (im.complemento) caractsXml.push(xmlCaracteristicaImovelweb('2000199', { valor: im.complemento }));
    // Comodidades (booleanas) mapeadas do texto livre de características do imóvel
    caracteristicasExtrasImovelweb(im).forEach((id) => caractsXml.push(xmlCaracteristicaImovelweb(id, { idValor: '1' })));
    if (!caractsXml.length) caractsXml.push(xmlCaracteristicaImovelweb('CFT2', { valor: im.quartos || 0 }));

    const precos = [];
    if ((im.finalidade === 'venda' || im.finalidade === 'venda_locacao') && im.valor_venda) {
      precos.push(`<preco><quantidade><![CDATA[${Math.round(im.valor_venda)}]]></quantidade><moeda><![CDATA[BRL]]></moeda><operacao><![CDATA[VENTA]]></operacao></preco>`);
    }
    if ((im.finalidade === 'locacao' || im.finalidade === 'venda_locacao') && im.valor_locacao) {
      precos.push(`<preco><quantidade><![CDATA[${Math.round(im.valor_locacao)}]]></quantidade><moeda><![CDATA[BRL]]></moeda><operacao><![CDATA[ALQUILER]]></operacao></preco>`);
    }
    if (!precos.length) return; // sem preço em nenhuma operação — Imovelweb rejeitaria

    const imagensXml = fotos.slice(0, 50).map((url) => `<imagem>${xmlOpenNaventTag('urlImagem', url)}</imagem>`).join('');

    blocos.push(`
    <Imovel>
      ${xmlOpenNaventTag('codigoAnuncio', (im.codigo || im.id).toString().slice(0, 100))}
      ${xmlOpenNaventTag('codigoReferencia', (im.codigo || im.id).toString().slice(0, 99))}
      ${xmlOpenNaventTag('titulo', titulo)}
      ${xmlOpenNaventTag('descricao', descricao)}
      <tipoPropriedade>
        ${xmlOpenNaventTag('idTipo', mapaTipo.idTipo)}
        ${xmlOpenNaventTag('tipo', mapaTipo.tipo)}
        ${xmlOpenNaventTag('idSubTipo', mapaTipo.idSubTipo)}
        ${xmlOpenNaventTag('subTipo', mapaTipo.subTipo)}
      </tipoPropriedade>
      <caracteristicas>${caractsXml.join('')}</caracteristicas>
      <precos>${precos.join('')}</precos>
      <multimidia><imagens>${imagensXml}</imagens></multimidia>
      <localizacao>
        ${xmlOpenNaventTag('endereco', endereco)}
        ${xmlOpenNaventTag('idLocalidade', resolverIdLocalidadeImovelweb(im.cidade, im.bairro))}
        ${xmlOpenNaventTag('codigoPostal', im.cep || '')}
        ${xmlOpenNaventTag('mostrarMapa', (im.latitude && im.longitude) ? 'EXACTO' : 'APROXIMADO')}
        ${im.latitude ? xmlOpenNaventTag('latitude', im.latitude) : ''}
        ${im.longitude ? xmlOpenNaventTag('longitude', im.longitude) : ''}
      </localizacao>
      <publicacao>${xmlOpenNaventTag('tipoPublicacao', TIPO_PUBLICACAO_IMOVELWEB[nivel] || 'SIMPLE')}</publicacao>
      <publicador>
        ${xmlOpenNaventTag('codigoImobiliaria', PUBLICADOR_IMOVELWEB.codigoImobiliaria)}
        ${xmlOpenNaventTag('emailContato', PUBLICADOR_IMOVELWEB.emailContato)}
        ${xmlOpenNaventTag('nomeContato', PUBLICADOR_IMOVELWEB.nomeContato)}
        ${xmlOpenNaventTag('telefoneContato', PUBLICADOR_IMOVELWEB.telefoneContato)}
      </publicador>
    </Imovel>`);
  });

  if (semFotosSuficientes.length) {
    toast(`${semFotosSuficientes.length} imóvel(is) ficaram de fora por ter menos de 5 fotos (exigência da Imovelweb): ${semFotosSuficientes.join(', ')}`, true);
  }
  if (lancamentosIgnorados.length) {
    toast(`${lancamentosIgnorados.length} lançamento(s) fora de Curitiba ficaram de fora (só lançamento de Curitiba pode ir pro Imovelweb): ${lancamentosIgnorados.join(', ')}`, true);
  }

  // 2026-08-25: Rosana/Imovelweb confirmou que a seção <Lancamentos> que construímos NÃO é o
  // formato real aceito por eles (o exemplo oficial que usamos de base não reflete o sistema
  // deles); pra lançamentos "de verdade" é preciso contratar um plano adicional ("fichas") com
  // o executivo de contas. Até isso ser contratado, voltamos ao formato só de classificados —
  // lançamentos (situacao='lancamento') simplesmente não entram nesse XML.
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenNavent>
  <dataModificacao>${Date.now()}</dataModificacao>
  <Imoveis>${blocos.join('')}
  </Imoveis>
</OpenNavent>`;
}

// Extrai "mês/ano" de entrega da descrição (ex: "entrega prevista para maio de 2030",
// "entrega prevista para fevereiro/2030") e devolve no formato MM-YYYY exigido pela tag
// <dataEntrega>. Retorna null se não achar (não inventamos data).
const MESES_PT = { janeiro: '01', fevereiro: '02', marco: '03', março: '03', abril: '04', maio: '05', junho: '06', julho: '07', agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12' };
function extrairDataEntrega(descricao) {
  if (!descricao) return null;
  const texto = normalizarTextoImovelweb(descricao);
  const m = texto.match(/entrega[^0-9.]*?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)[^0-9.]*?(\d{4})/);
  if (!m) return null;
  return `${MESES_PT[m[1]]}-${m[2]}`;
}
function etapaLancamentoLabel(titulo) {
  const t = normalizarTextoImovelweb(titulo);
  if (t.includes('em obras')) return 'Em Construção';
  if (t.includes('breve lancamento')) return 'Breve Lançamento';
  if (t.includes('entregue')) return 'Entregue';
  return 'Lançamento';
}

// --- Imovelweb — blocos de LANÇAMENTOS (<Lancamento><unidades><unidade>...) ---
// Layout diferente do XML de classificados (confirmado pela Rosana/Imovelweb em 2026-08-24):
// cada empreendimento (grupo_empreendimento) vira UM <Lancamento>, com cada tipologia/unidade
// disponível dentro de <unidades><unidade>. Retorna só os blocos (não o documento inteiro),
// pra poder ser combinado com <Imoveis> no mesmo arquivo, como o próprio exemplo oficial deles faz.
function blocosLancamentosImovelweb(imoveisSelecionados) {
  const semFotosSuficientes = [];
  const grupos = new Map();
  imoveisSelecionados.forEach((im) => {
    if (im.situacao !== 'lancamento') return;
    const chave = im.grupo_empreendimento || im.codigo;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(im);
  });

  const blocosLancamento = [];
  grupos.forEach((unidades, grupoCodigo) => {
    const unidadesComFotos = unidades.filter((u) => xmlFotosArray(u).length >= 5);
    const semFoto = unidades.filter((u) => xmlFotosArray(u).length < 5);
    semFoto.forEach((u) => semFotosSuficientes.push(u.codigo || u.titulo || u.id));
    if (!unidadesComFotos.length) return;

    const representante = unidadesComFotos.slice().sort((a, b) => (Number(a.valor_venda) || Infinity) - (Number(b.valor_venda) || Infinity))[0];
    const mapaTipoRepresentante = MAPA_TIPO_IMOVELWEB[representante.tipo] || MAPA_TIPO_IMOVELWEB.apartamento;
    const nivel = nivelDestaquePortal(representante, 'imovelweb');
    const nomeEmpreend = (representante.titulo || '').split(' — ')[0].trim();

    let descricaoLancamento = (representante.descricao || '').trim();
    if (descricaoLancamento.length < 50) descricaoLancamento = `${descricaoLancamento} Lançamento comercializado pela Gregório | Meu Lar Imobiliária.`.trim();
    descricaoLancamento = descricaoLancamento.slice(0, 10000);

    const enderecoLancamento = [representante.endereco, representante.numero].filter(Boolean).join(', ').slice(0, 200) || 'Endereço a confirmar';
    const fotosRepresentante = xmlFotosArray(representante);
    const imagensLancamentoXml = fotosRepresentante.slice(0, 50).map((url) => `<imagem>${xmlOpenNaventTag('urlImagem', url)}</imagem>`).join('');

    const caractsLancamento = [];
    if (representante.quartos) caractsLancamento.push(xmlCaracteristicaImovelweb('CFT2', { valor: representante.quartos }));
    if (representante.area_construida) caractsLancamento.push(xmlCaracteristicaImovelweb('CFT101', { valor: representante.area_construida }));
    caracteristicasExtrasImovelweb(representante).forEach((id) => caractsLancamento.push(xmlCaracteristicaImovelweb(id, { idValor: '1' })));
    if (!caractsLancamento.length) caractsLancamento.push(xmlCaracteristicaImovelweb('CFT2', { valor: representante.quartos || 0 }));

    const dataEntrega = extrairDataEntrega(representante.descricao);

    // --- Unidades (cada tipologia disponível do empreendimento) ---
    const unidadesXml = unidadesComFotos.map((u) => {
      const mapaTipoU = MAPA_TIPO_IMOVELWEB[u.tipo] || MAPA_TIPO_IMOVELWEB.apartamento;
      let descricaoU = (u.descricao || '').trim();
      if (descricaoU.length < 50) descricaoU = `${descricaoU} Unidade disponível no lançamento ${nomeEmpreend}.`.trim();
      descricaoU = descricaoU.slice(0, 10000);

      const caractsU = [];
      if (u.quartos) caractsU.push(xmlCaracteristicaImovelweb('CFT2', { valor: u.quartos }));
      if (u.banheiros) caractsU.push(xmlCaracteristicaImovelweb('CFT3', { valor: u.banheiros }));
      if (u.suites) caractsU.push(xmlCaracteristicaImovelweb('CFT4', { valor: u.suites }));
      if (u.vagas_garagem) caractsU.push(xmlCaracteristicaImovelweb('CFT7', { valor: u.vagas_garagem }));
      if (u.area_total) caractsU.push(xmlCaracteristicaImovelweb('CFT100', { valor: u.area_total }));
      if (u.area_construida) caractsU.push(xmlCaracteristicaImovelweb('CFT101', { valor: u.area_construida }));
      if (u.valor_condominio) caractsU.push(xmlCaracteristicaImovelweb('CFT6', { valor: u.valor_condominio }));
      if (u.valor_iptu) caractsU.push(xmlCaracteristicaImovelweb('CFT400', { valor: u.valor_iptu }));
      caracteristicasExtrasImovelweb(u).forEach((id) => caractsU.push(xmlCaracteristicaImovelweb(id, { idValor: '1' })));
      if (!caractsU.length) caractsU.push(xmlCaracteristicaImovelweb('CFT2', { valor: u.quartos || 0 }));

      const precosU = [];
      if (u.valor_venda) precosU.push(`<preco><quantidade><![CDATA[${Math.round(u.valor_venda)}]]></quantidade><moeda><![CDATA[BRL]]></moeda><operacao><![CDATA[VENTA]]></operacao></preco>`);
      if (u.valor_locacao) precosU.push(`<preco><quantidade><![CDATA[${Math.round(u.valor_locacao)}]]></quantidade><moeda><![CDATA[BRL]]></moeda><operacao><![CDATA[ALQUILER]]></operacao></preco>`);

      const imagensU = xmlFotosArray(u).slice(0, 50).map((url) => `<imagem>${xmlOpenNaventTag('urlImagem', url)}</imagem>`).join('');

      return `
      <unidade>
        ${xmlOpenNaventTag('codigoAnuncio', (u.codigo || u.id).toString().slice(0, 100))}
        ${xmlOpenNaventTag('codigoReferencia', (u.codigo || u.id).toString().slice(0, 99))}
        <tipoPropriedade>
          ${xmlOpenNaventTag('idTipo', mapaTipoU.idTipo)}
          ${xmlOpenNaventTag('tipo', mapaTipoU.tipo)}
          ${xmlOpenNaventTag('idSubTipo', mapaTipoU.idSubTipo)}
          ${xmlOpenNaventTag('subTipo', mapaTipoU.subTipo)}
        </tipoPropriedade>
        ${xmlOpenNaventTag('titulo', (u.titulo || nomeEmpreend).slice(0, 80))}
        ${xmlOpenNaventTag('descricao', descricaoU)}
        <caracteristicas>${caractsU.join('')}</caracteristicas>
        <multimidia><imagens>${imagensU}</imagens></multimidia>
        <precos>${precosU.join('')}</precos>
      </unidade>`;
    }).join('');

    blocosLancamento.push(`
    <Lancamento>
      ${xmlOpenNaventTag('codigoAnuncio', grupoCodigo.toString().slice(0, 100))}
      ${xmlOpenNaventTag('codigoReferencia', grupoCodigo.toString().slice(0, 99))}
      ${xmlOpenNaventTag('titulo', nomeEmpreend.slice(0, 80))}
      ${xmlOpenNaventTag('descricao', descricaoLancamento)}
      <tipoPropriedade>
        ${xmlOpenNaventTag('idTipo', mapaTipoRepresentante.idTipo)}
        ${xmlOpenNaventTag('tipo', mapaTipoRepresentante.tipo)}
        ${xmlOpenNaventTag('idSubTipo', mapaTipoRepresentante.idSubTipo)}
        ${xmlOpenNaventTag('subTipo', mapaTipoRepresentante.subTipo)}
      </tipoPropriedade>
      ${xmlOpenNaventTag('etapaLancamento', etapaLancamentoLabel(representante.titulo))}
      ${dataEntrega ? xmlOpenNaventTag('dataEntrega', dataEntrega) : ''}
      <caracteristicas>${caractsLancamento.join('')}</caracteristicas>
      <multimidia><imagens>${imagensLancamentoXml}</imagens></multimidia>
      <localizacao>
        ${xmlOpenNaventTag('endereco', enderecoLancamento)}
        ${xmlOpenNaventTag('idLocalidade', resolverIdLocalidadeImovelweb(representante.cidade, representante.bairro))}
        ${xmlOpenNaventTag('codigoPostal', representante.cep || '')}
        ${xmlOpenNaventTag('mostrarMapa', (representante.latitude && representante.longitude) ? 'EXACTO' : 'APROXIMADO')}
        ${representante.latitude ? xmlOpenNaventTag('latitude', representante.latitude) : ''}
        ${representante.longitude ? xmlOpenNaventTag('longitude', representante.longitude) : ''}
      </localizacao>
      <publicacao>${xmlOpenNaventTag('tipoPublicacao', TIPO_PUBLICACAO_IMOVELWEB[nivel] || 'SIMPLE')}</publicacao>
      <publicador>
        ${xmlOpenNaventTag('codigoImobiliaria', PUBLICADOR_IMOVELWEB.codigoImobiliaria)}
        ${xmlOpenNaventTag('emailContato', PUBLICADOR_IMOVELWEB.emailContato)}
        ${xmlOpenNaventTag('nomeContato', PUBLICADOR_IMOVELWEB.nomeContato)}
        ${xmlOpenNaventTag('telefoneContato', PUBLICADOR_IMOVELWEB.telefoneContato)}
      </publicador>
      <unidades>${unidadesXml}</unidades>
    </Lancamento>`);
  });

  return { blocos: blocosLancamento, semFotosSuficientes };
}

function gerarXmlGenerico(imoveis, portal) {
  const blocos = [];
  imoveis.forEach((im) => {
    const fotos = xmlFotosArray(im);
    const fotosXml = fotos.map((url, i) => `
        <Foto>
          <Nome>${xmlCdata(`foto-${i + 1}.jpg`)}</Nome>
          <URL>${xmlCdata(url)}</URL>
          <Principal>${i === 0 ? 1 : 0}</Principal>
        </Foto>`).join('');

    const montarBloco = (codigo, finalidade, preco) => `
    <Imovel>
      <NomeAnunciante>${xmlCdata('Gregório | Meu Lar Imobiliária')}</NomeAnunciante>
      <UrlImovel>${xmlCdata(xmlUrlImovel(im))}</UrlImovel>
      <Codigo>${xmlCdata(codigo)}</Codigo>
      <DataCriacao>${xmlDataHora(im.criado_em)}</DataCriacao>
      <DataAtualizacao>${xmlDataHora(im.atualizado_em)}</DataAtualizacao>
      <Status>${im.status === 'disponivel' || im.status === 'reservado' ? 1 : 0}</Status>
      <Destaque>${nivelDestaqueNumero(nivelDestaquePortal(im, portal))}</Destaque>
      <Titulo>${xmlCdata(im.titulo)}</Titulo>
      <TipoImovel>${xmlCdata(TIPO_XML_GENERICO[im.tipo] || 'Outros Imóveis')}</TipoImovel>
      <Fase>${xmlCdata(im.situacao === 'lancamento' ? 'Na planta' : 'Pronto para Morar')}</Fase>
      <Finalidade>${xmlCdata(finalidade)}</Finalidade>
      <Valor>
        <Preco>${xmlCdata(xmlNum(preco))}</Preco>

        <Condominio>${xmlCdata(xmlNum(im.valor_condominio))}</Condominio>
        <IPTU>${xmlCdata(xmlNum(im.valor_iptu))}</IPTU>
      </Valor>
      <Localizacao>
        <Estado>${xmlCdata(im.estado)}</Estado>
        <Cidade>${xmlCdata(im.cidade)}</Cidade>
        <Bairro>${xmlCdata(im.bairro)}</Bairro>
        <Endereco>${xmlCdata(im.endereco)}</Endereco>
        <Numero>${xmlCdata(im.numero)}</Numero>
        <Complemento>${xmlCdata(im.complemento)}</Complemento>
        <CEP>${xmlCdata(im.cep)}</CEP>
        <Latitude>${xmlCdata(im.latitude ?? '')}</Latitude>
        <Longitude>${xmlCdata(im.longitude ?? '')}</Longitude>
      </Localizacao>
      <Area>
        <Total>${xmlCdata(im.area_total ?? '')}</Total>
        <Util>${xmlCdata(im.area_construida ?? '')}</Util>
        <Terreno>${xmlCdata('')}</Terreno>
      </Area>
      <Caracteristicas>
        <Dormitorios>${xmlCdata(im.quartos ?? '')}</Dormitorios>
        <Suites>${xmlCdata(im.suites ?? '')}</Suites>
        <Vagas>${xmlCdata(im.vagas_garagem ?? '')}</Vagas>
        <Banheiros>${xmlCdata(im.banheiros ?? '')}</Banheiros>
        <Salas>${xmlCdata(im.salas ?? '')}</Salas>
        <AnoConstrucao>${xmlCdata(im.ano_construcao ?? '')}</AnoConstrucao>
      </Caracteristicas>
      <Descricao>${xmlCdata([im.descricao, im.pontos_fortes].filter(Boolean).join('\n\n'))}</Descricao>
      <Fotos>${fotosXml}
      </Fotos>${im.video_url ? `
      <Videos>
        <Video><Nome>${xmlCdata('Vídeo do imóvel')}</Nome><URL>${xmlCdata(im.video_url)}</URL></Video>
      </Videos>` : ''}
    </Imovel>`;

    if (im.finalidade === 'venda_locacao') {
      blocos.push(montarBloco(`${im.codigo || im.id}-V`, 'Venda', im.valor_venda));
      blocos.push(montarBloco(`${im.codigo || im.id}-L`, 'Locacao', im.valor_locacao));
    } else {
      const finalidade = im.finalidade === 'locacao' ? 'Locacao' : 'Venda';
      const preco = im.finalidade === 'locacao' ? im.valor_locacao : im.valor_venda;
      blocos.push(montarBloco(im.codigo || im.id, finalidade, preco));
    }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<Carga xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Imoveis>${blocos.join('')}
  </Imoveis>
</Carga>`;
}

// --- Chaves na Mão — layout oficial (tecnologiacnm.github.io/cnm-xml-documentation) ---
const TIPO_CNM = {
  casa: { tipo: 'Casa / Sobrado', finalidade: 'RE' },
  apartamento: { tipo: 'Apartamento', finalidade: 'RE' },
  terreno: { tipo: 'Terreno / Lote', finalidade: 'RE' },
  sitio: { tipo: 'Sítio / Chácara', finalidade: 'RE' },
  fazenda: { tipo: 'Fazenda', finalidade: 'CO' },
  comercial: { tipo: 'Ponto Comercial', finalidade: 'CO' },
  galpao: { tipo: 'Galpão / Depósito', finalidade: 'CO' },
  sala_comercial: { tipo: 'Conj. Comercial / Sala', finalidade: 'CO' },
  area_rural: { tipo: 'Fazenda', finalidade: 'CO' },
  area_urbana: { tipo: 'Terreno / Lote', finalidade: 'RE' },
};

function gerarXmlChavesNaMao(imoveis) {
  const itens = imoveis.map((im) => {
    const mapa = TIPO_CNM[im.tipo] || { tipo: 'Casa / Sobrado', finalidade: 'RE' };
    const fotos = xmlFotosArray(im);
    const dataAtualizacaoFoto = xmlDataHora(im.atualizado_em) || xmlDataHora(new Date());
    const fotosXml = fotos.map((url) => `
                <foto>
                    <url>${xmlEsc(url)}</url>
                    <data_atualizacao>${dataAtualizacaoFoto}</data_atualizacao>
                </foto>`).join('');

    const temVenda = im.finalidade === 'venda' || im.finalidade === 'venda_locacao';
    const temLocacao = im.finalidade === 'locacao' || im.finalidade === 'venda_locacao';
    const transacao = temVenda ? 'V' : 'L';
    const transacao2 = im.finalidade === 'venda_locacao' ? 'L' : '';
    const valor = temVenda ? xmlNum(im.valor_venda) : xmlNum(im.valor_locacao);
    const valorLocacao = im.finalidade === 'venda_locacao' ? xmlNum(im.valor_locacao) : '';
    const referencia = im.codigo || im.id;
    const descritivo = [im.descricao, im.pontos_fortes].filter(Boolean).join('\n\n');

    return `
        <imovel>
            <referencia>${xmlEsc(referencia)}</referencia>
            <codigo_cliente>${xmlEsc(referencia)}</codigo_cliente>
            <link_cliente>${xmlEsc(xmlUrlImovel(im))}</link_cliente>
            <titulo>${xmlEsc(im.titulo || '')}</titulo>
            <transacao>${transacao}</transacao>
            <transacao2>${transacao2}</transacao2>
            <finalidade>${mapa.finalidade}</finalidade>
            <finalidade2></finalidade2>
            <destaque>${nivelDestaqueNumero(nivelDestaquePortal(im, 'chaves_na_mao')) > 0 ? 1 : 0}</destaque>
            <tipo>${mapa.tipo}</tipo>
            <tipo2></tipo2>
            <valor>${valor}</valor>
            <valor_locacao>${valorLocacao}</valor_locacao>
            <valor_iptu>${xmlNum(im.valor_iptu)}</valor_iptu>
            <valor_condominio>${xmlNum(im.valor_condominio)}</valor_condominio>
            <area_total>${im.area_total ?? ''}</area_total>
            <area_util>${im.area_construida ?? ''}</area_util>
            <conservacao></conservacao>
            <quartos>${im.quartos ?? ''}</quartos>
            <suites>${im.suites ?? ''}</suites>
            <garagem>${im.vagas_garagem ?? ''}</garagem>
            <banheiro>${im.banheiros ?? ''}</banheiro>
            <closet></closet>
            <salas>${im.salas ?? ''}</salas>
            <despensa></despensa>
            <bar></bar>
            <cozinha></cozinha>
            <quarto_empregada></quarto_empregada>
            <escritorio></escritorio>
            <area_servico></area_servico>
            <lareira></lareira>
            <varanda></varanda>
            <lavanderia></lavanderia>
            <aceita_pet></aceita_pet>
            <estado>${xmlEsc(im.estado || '')}</estado>
            <cidade>${xmlEsc(im.cidade || '')}</cidade>
            <bairro>${xmlEsc(im.bairro || '')}</bairro>
            <cep>${(im.cep || '').replace(/\D/g, '')}</cep>
            <endereco>${xmlEsc(im.endereco || '')}</endereco>
            <numero>${xmlEsc(im.numero || '')}</numero>
            <complemento>${xmlEsc(im.complemento || '')}</complemento>
            <esconder_endereco_imovel>0</esconder_endereco_imovel>
            <descritivo>${xmlCdata(descritivo)}</descritivo>
            <fotos_imovel>${fotosXml}
            </fotos_imovel>
            <data_atualizacao>${xmlDataHora(im.atualizado_em)}</data_atualizacao>
            <latitude>${im.latitude ?? ''}</latitude>
            <longitude>${im.longitude ?? ''}</longitude>
            <video>${xmlEsc(im.video_url || '')}</video>
            <tour_360>${xmlEsc(im.tour_virtual_url || '')}</tour_360>
            <area_comum></area_comum>
            <area_privativa></area_privativa>
            <aceita_troca>${im.aceita_permuta ? 1 : 0}</aceita_troca>
            <periodo_locacao></periodo_locacao>
        </imovel>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document>
    <imoveis>${itens}
    </imoveis>
</Document>`;
}

async function imovelForm(im = {}) {
  const [{ data: corretores }, { data: pessoas }] = await Promise.all([
    supabase.from('usuarios').select('id,nome,ativo').order('nome'),
    supabase.from('pessoas').select('id,nome,telefone').order('nome'),
  ]);

  // Imóvel novo não marca nenhum portal por padrão — corretor escolhe manualmente na hora de cadastrar.
  const portaisSelecionadosImovel = im.portais_publicacao || [];
  const portaisDestaqueImovel = im.portais_destaque || {};

  return `
    <h2>${im.id ? 'Editar imóvel' : 'Novo imóvel'}</h2>
    <form class="modal-form" id="imovelForm">
      <input type="hidden" id="im-id" value="${im.id || ''}">
      <div class="form-row full"><label>Título</label><input required id="im-titulo" value="${im.titulo || ''}"></div>
      <div class="form-row"><label>Código</label><input id="im-codigo" value="${im.codigo || ''}"></div>
      <div class="form-row"><label>Matrícula (cartório)</label><input id="im-matricula" value="${im.matricula || ''}" placeholder="Nº de matrícula, usado em contratos"></div>
      <div class="form-row"><label>Corretor responsável${podeVerFinanceiro ? '' : ' (você — só gerente/admin pode transferir)'}</label>
        <select id="im-corretor" ${podeVerFinanceiro ? '' : 'disabled'}>
          <option value="">Sem corretor definido</option>
          ${(corretores || []).filter((c) => c.ativo !== false).map((c) => `<option value="${c.id}" ${c.id === (im.corretor_responsavel_id || (!im.id ? currentUsuario?.id : null)) ? 'selected' : ''}>${c.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full">
        <label>Proprietário</label>
        <div class="proprietario-picker">
          <select id="im-proprietario">
            <option value="">Sem proprietário definido</option>
            ${(pessoas || []).map((p) => `<option value="${p.id}" ${p.id === im.proprietario_id ? 'selected' : ''}>${p.nome}${p.telefone ? ' — ' + p.telefone : ''}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-ghost btn-sm" id="im-novo-proprietario-btn">+ Novo proprietário</button>
        </div>
      </div>
      <div class="form-row full proprietario-novo" id="im-proprietario-novo" hidden>
        <label>Dados do novo proprietário</label>
        <div class="proprietario-novo-grid">
          <input id="im-prop-nome" placeholder="Nome completo">
          <input id="im-prop-telefone" placeholder="Telefone">
          <input type="email" id="im-prop-email" placeholder="E-mail (opcional)">
          <input id="im-prop-cpf" placeholder="CPF/CNPJ (opcional)">
        </div>
        <p style="font-size:.75rem;color:var(--gray-text);margin:2px 0 6px;">Ao salvar o imóvel, essa pessoa é cadastrada automaticamente com o papel "proprietário" e já aparece na aba Pessoas.</p>
        <button type="button" class="btn btn-ghost btn-sm" id="im-cancelar-novo-proprietario">Cancelar novo proprietário</button>
      </div>
      <div class="form-row"><label>Tipo</label>
        <select id="im-tipo">${TIPOS_IMOVEL.map((t) => `<option value="${t}" ${t === im.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>Finalidade</label>
        <select id="im-finalidade">
          <option value="venda" ${im.finalidade === 'venda' ? 'selected' : ''}>Venda</option>
          <option value="locacao" ${im.finalidade === 'locacao' ? 'selected' : ''}>Locação</option>
          <option value="venda_locacao" ${im.finalidade === 'venda_locacao' ? 'selected' : ''}>Venda e locação</option>
        </select>
      </div>
      <div class="form-row"><label>Situação</label>
        <select id="im-situacao">
          <option value="pronto" ${(im.situacao || 'pronto') === 'pronto' ? 'selected' : ''}>Pronto / usado</option>
          <option value="lancamento" ${im.situacao === 'lancamento' ? 'selected' : ''}>Lançamento (na planta)</option>
        </select>
      </div>
      <div class="form-row"><label>Previsão de entrega (lançamento)</label><input type="date" id="im-previsao-entrega" value="${im.previsao_entrega || ''}"></div>
      <div class="form-row"><label>Status</label>
        <select id="im-status">${STATUS_IMOVEL.map((s) => `<option value="${s}" ${s === im.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>Cidade</label><input id="im-cidade" value="${im.cidade || 'Fazenda Rio Grande'}"></div>
      <div class="form-row"><label>Estado</label><input id="im-estado" value="${im.estado || 'PR'}"></div>
      <div class="form-row"><label>Bairro</label><input id="im-bairro" value="${im.bairro || ''}"></div>
      <div class="form-row"><label>Zona</label>
        <select id="im-zona">
          ${['', 'Norte', 'Sul', 'Leste', 'Oeste', 'Centro'].map((z) => `<option value="${z}" ${z === (im.zona || '') ? 'selected' : ''}>${z || '—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Endereço (rua)</label><input id="im-endereco" value="${im.endereco || ''}"></div>
      <div class="form-row"><label>Número</label><input id="im-numero" value="${im.numero || ''}"></div>
      <div class="form-row"><label>Complemento</label><input id="im-complemento" value="${im.complemento || ''}"></div>
      <div class="form-row"><label>CEP</label><input id="im-cep" value="${im.cep || ''}"></div>
      <div class="form-row full"><small id="im-cep-status" class="imovel-card-meta" hidden></small></div>
      <div class="form-row full"><label>Ponto de referência</label><input id="im-ponto-referencia" value="${im.ponto_referencia || ''}" placeholder="Ex: 1 minuto da BR-116, próximo à Escola Municipal..."></div>
      <div class="form-row"><label>Valor de venda (R$)</label><input type="number" id="im-valor-venda" value="${im.valor_venda || ''}"></div>
      <div class="form-row"><label>Valor de locação (R$)</label><input type="number" id="im-valor-locacao" value="${im.valor_locacao || ''}"></div>
      <div class="form-row"><label>Condomínio (R$)</label><input type="number" id="im-valor-condominio" value="${im.valor_condominio || ''}"></div>
      <div class="form-row"><label>IPTU (R$)</label><input type="number" id="im-valor-iptu" value="${im.valor_iptu || ''}"></div>
      <div class="form-row"><label>Quartos</label><input type="number" id="im-quartos" value="${im.quartos || ''}"></div>
      <div class="form-row"><label>Suítes</label><input type="number" id="im-suites" value="${im.suites || ''}"></div>
      <div class="form-row"><label>Banheiros</label><input type="number" id="im-banheiros" value="${im.banheiros || ''}"></div>
      <div class="form-row"><label>Salas</label><input type="number" id="im-salas" value="${im.salas || ''}"></div>
      <div class="form-row"><label>Vagas garagem</label><input type="number" id="im-vagas" value="${im.vagas_garagem || ''}"></div>
      <div class="form-row"><label>Ano de construção</label><input type="number" id="im-ano" value="${im.ano_construcao || ''}"></div>
      <div class="form-row"><label>Área total (m²)</label><input type="number" id="im-area" value="${im.area_total || ''}"></div>
      <div class="form-row"><label>Área construída (m²)</label><input type="number" id="im-area-construida" value="${im.area_construida || ''}"></div>
      <div class="form-row"><label>Terreno — frente (m)</label><input type="number" id="im-terreno-frente" value="${im.terreno_frente || ''}"></div>
      <div class="form-row"><label>Terreno — fundo (m)</label><input type="number" id="im-terreno-fundo" value="${im.terreno_fundo || ''}"></div>
      <div class="form-row"><label>Terreno — lateral esquerda (m)</label><input type="number" id="im-terreno-esq" value="${im.terreno_lateral_esquerda || ''}"></div>
      <div class="form-row"><label>Terreno — lateral direita (m)</label><input type="number" id="im-terreno-dir" value="${im.terreno_lateral_direita || ''}"></div>
      <div class="form-row full">
        <label style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span>Descrição</span>
          <button type="button" class="btn btn-ghost btn-sm" id="im-gerar-descricao-btn">✨ Gerar com IA</button>
        </label>
        <textarea id="im-descricao" rows="3">${im.descricao || ''}</textarea>
      </div>
      <div class="form-row full"><label>Pontos fortes (destaques de marketing)</label><textarea id="im-pontos-fortes" rows="3" placeholder="Ex: Sala com pé-direito duplo, piscina exclusiva, acabamento em granito...">${im.pontos_fortes || ''}</textarea></div>
      <div class="form-row full"><label>Características (separe por vírgula)</label><input id="im-caracteristicas" value="${(im.caracteristicas || []).join(', ')}" placeholder="Ex: Portão eletrônico, Churrasqueira, Piscina"></div>
      <div class="form-row full"><label>Cômodos (separe por vírgula)</label><input id="im-comodos" value="${(im.comodos || []).join(', ')}" placeholder="Ex: Área de serviço, Cozinha, Mezanino"></div>
      <div class="form-row full"><label>Proximidades (separe por vírgula)</label><input id="im-proximidades" value="${(im.proximidades || []).join(', ')}" placeholder="Ex: Escola, Supermercado, Farmácia"></div>
      <div class="form-row full"><label>Vídeo (link do YouTube)</label><input id="im-video-url" type="url" value="${im.video_url || ''}" placeholder="https://www.youtube.com/watch?v=..."></div>
      <div class="form-row full"><label>Tour virtual 360° (link)</label><input id="im-tour-virtual" type="url" value="${im.tour_virtual_url || ''}" placeholder="https://..."></div>
      <div class="form-row"><label>Latitude</label><input id="im-latitude" type="number" step="any" value="${im.latitude ?? ''}" placeholder="Ex: -25.6467"></div>
      <div class="form-row"><label>Longitude</label><input id="im-longitude" type="number" step="any" value="${im.longitude ?? ''}" placeholder="Ex: -49.3086"></div>
      <p style="grid-column:1/-1;font-size:.75rem;margin:-6px 0 0;">Dica: abra o imóvel no Google Maps, clique com o botão direito no local exato e copie as coordenadas.</p>
      <div class="form-row full upload-row">
        <label>Fotos do imóvel — clique na estrela pra escolher a foto principal (capa)</label>
        <div class="fotos-grid" id="im-fotos-grid"></div>
        <input type="file" id="im-fotos-file" accept="image/*" multiple>
        <div class="marca-dagua-config">
          <label class="check-row"><input type="checkbox" id="im-marca-dagua" checked> Aplicar marca d'água (logo) nas fotos novas</label>
          <div class="marca-dagua-opcoes">
            <label>Posição
              <select id="im-marca-posicao">
                <option value="centro" selected>Centro (padrão)</option>
                <option value="superior-esquerda">Superior esquerda</option>
                <option value="superior-direita">Superior direita</option>
                <option value="inferior-esquerda">Inferior esquerda</option>
                <option value="inferior-direita">Inferior direita</option>
              </select>
            </label>
            <label>Transparência (<span id="im-marca-transparencia-valor">50</span>%)
              <input type="range" id="im-marca-transparencia" min="20" max="80" step="5" value="50">
            </label>
          </div>
        </div>
      </div>
      <div class="form-row full" style="display:flex;gap:20px;flex-wrap:wrap;">
        <label class="check-row"><input type="checkbox" id="im-mcmv" ${im.elegivel_mcmv ? 'checked' : ''}> Elegível MCMV</label>
        <label class="check-row"><input type="checkbox" id="im-financiamento" ${im.aceita_financiamento ? 'checked' : ''}> Aceita financiamento</label>
        <label class="check-row"><input type="checkbox" id="im-permuta" ${im.aceita_permuta ? 'checked' : ''}> Aceita permuta</label>
        <label class="check-row"><input type="checkbox" id="im-luxo" ${im.imovel_luxo ? 'checked' : ''}> Alto padrão</label>
        <label class="check-row"><input type="checkbox" id="im-destaque" ${im.destaque ? 'checked' : ''}> Destaque no site</label>
        <label class="check-row"><input type="checkbox" id="im-publicado" ${im.publicado !== false ? 'checked' : ''}> Publicado no site</label>
      </div>
      <div class="form-row full">
        <label>Espelhar para portais externos (feed XML)${souGestaoPortais ? '' : ' <span style="font-weight:400;color:var(--gray-text);">— somente gerente/admin podem alterar</span>'}</label>
        <div class="portais-xml-grid">
          ${PORTAIS_XML.map((p) => {
            const marcado = portaisSelecionadosImovel.includes(p.key);
            const nivel = portaisDestaqueImovel[p.key] || 'simples';
            const bloqueado = !souGestaoPortais;
            return `
          <div class="portal-xml-row">
            <label class="check-row"><input type="checkbox" class="im-portal-check" data-portal="${p.key}" ${marcado ? 'checked' : ''} ${bloqueado ? 'disabled' : ''}> ${p.label}</label>
            <select class="im-portal-nivel" data-portal="${p.key}" ${(marcado && !bloqueado) ? '' : 'disabled'}>
              <option value="simples" ${nivel === 'simples' ? 'selected' : ''}>Anúncio simples</option>
              <option value="destaque" ${nivel === 'destaque' ? 'selected' : ''}>Destaque</option>
              <option value="super_destaque" ${nivel === 'super_destaque' ? 'selected' : ''}>Super destaque</option>
            </select>
          </div>`;
          }).join('')}
        </div>
      </div>
      ${im.id ? `
      <div class="form-row full">
        <label>Documentos anexados (matrícula, laudo de vistoria, contrato...)</label>
        <div class="documentos-lista" id="documentosLista-imovel-${im.id}"><p class="table-empty">Carregando...</p></div>
        <input type="file" id="documentoFile-imovel-${im.id}">
      </div>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelImovel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  `;
}

$('#newImovelBtn').addEventListener('click', async () => { openModal(await imovelForm(), { persistente: true }); bindImovelForm(); });

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'imovel-duplicar') {
    const { data: original, error: erroOriginal } = await supabase.from('imoveis').select('*').eq('id', e.target.dataset.id).single();
    if (erroOriginal || !original) { toast('Não foi possível carregar o imóvel pra duplicar.', true); return; }

    const copia = {
      ...original,
      id: undefined,
      codigo: '',
      matricula: '',
      titulo: `${original.titulo || ''} (cópia)`.trim(),
      status: 'disponivel',
      publicado: false,
      destaque: false,
      visualizacoes: 0,
      motivo_desativacao: null,
      corretor_responsavel_id: null, // deixa em branco pra assumir automaticamente quem está duplicando
      criado_em: undefined,
      atualizado_em: undefined,
    };

    openModal(await imovelForm(copia), { persistente: true });
    bindImovelForm(copia);
    toast('Imóvel duplicado. Ajuste os dados que forem diferentes (endereço, código, valores etc.) e salve — ele começa como "não publicado" até você revisar.');
  }
  if (e.target.dataset.action === 'imovel-edit') {
    const { data: im } = await supabase.from('imoveis').select('*').eq('id', e.target.dataset.id).single();
    if (!im) return;
    openModal(await imovelForm(im), { persistente: true });
    bindImovelForm(im);
    carregarDocumentos('imovel', im.id);
    bindUploadDocumento('imovel', im.id);
  }
  if (e.target.dataset.action === 'imovel-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir imóveis.', true); return; }
    if (!confirm('Tem certeza que deseja excluir este imóvel?')) return;
    // a regra de quem pode excluir é garantida pelo banco (RLS): só o corretor responsável, ou gerente/admin
    const { data: excluidos, error } = await supabase.from('imoveis').delete().eq('id', e.target.dataset.id).select('id');
    if (error) { toast('Não foi possível excluir.', true); return; }
    if (!excluidos || !excluidos.length) {
      toast('Você não tem autorização para excluir este imóvel (apenas o corretor responsável, gerente ou admin podem).', true);
      return;
    }
    toast('Imóvel excluído.');
    loadImoveis();
  }
  if (e.target.dataset.action === 'imovel-marcar-vendido') {
    if (!confirm('Marcar este imóvel como vendido? Ele sai do site automaticamente.')) return;
    const { error } = await supabase.from('imoveis').update({ status: 'vendido' }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar.', true); return; }
    toast('Imóvel marcado como vendido e removido do site.');
    loadImoveis();
  }
  if (e.target.dataset.action === 'imovel-marcar-alugado') {
    if (!confirm('Marcar este imóvel como alugado? Ele sai do site automaticamente.')) return;
    const { error } = await supabase.from('imoveis').update({ status: 'alugado' }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar.', true); return; }
    toast('Imóvel marcado como alugado e removido do site.');
    loadImoveis();
  }
  if (e.target.dataset.action === 'imovel-desativar') {
    openModal(desativarImovelForm(e.target.dataset.id));
    bindDesativarImovelForm();
  }
  if (e.target.dataset.action === 'imovel-ativar') {
    if (!confirm('Reativar este imóvel? Ele volta a aparecer no site.')) return;
    const { error } = await supabase.from('imoveis').update({ status: 'disponivel', motivo_desativacao: null, publicado: true }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível reativar.', true); return; }
    toast('Imóvel reativado e publicado no site novamente.');
    loadImoveis();
  }
  if (e.target.dataset.action === 'imovel-ficha-pdf') {
    e.target.disabled = true;
    const textoOriginal = e.target.textContent;
    e.target.textContent = 'Gerando...';
    try {
      const { data: im } = await supabase.from('imoveis').select('*, corretor:usuarios!corretor_responsavel_id(nome,telefone,creci)').eq('id', e.target.dataset.id).single();
      if (im) await gerarFichaPdfImovel(im);
    } catch (err) {
      toast('Erro ao gerar a ficha: ' + err.message, true);
      console.error(err);
    }
    e.target.disabled = false;
    e.target.textContent = textoOriginal;
  }

  if (e.target.dataset.action === 'imovel-copiar-link') {
    const im = imoveisCache.find((i) => i.id === e.target.dataset.id);
    if (!im) return;
    const url = linkPublicoImovel(im);
    let copiou = false;
    try {
      await navigator.clipboard.writeText(url);
      copiou = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { copiou = document.execCommand('copy'); } catch { copiou = false; }
      ta.remove();
    }
    if (!copiou) { window.prompt('Copie o link do imóvel:', url); return; }
    toast(im.publicado
      ? 'Link do imóvel copiado — cole no WhatsApp do cliente.'
      : 'Link copiado, mas o imóvel está "Não publicado" — publique para o link abrir.', !im.publicado);
  }

  if (e.target.dataset.action === 'imovel-baixar-fotos') {
    const im = imoveisCache.find((i) => i.id === e.target.dataset.id);
    if (!im) return;
    e.target.disabled = true;
    const textoOriginal = e.target.textContent;
    try {
      await baixarFotosImovelZip(im);
    } catch (err) {
      toast('Erro ao baixar as fotos: ' + err.message, true);
      console.error(err);
    }
    e.target.disabled = false;
    e.target.textContent = textoOriginal;
  }
});

// =====================================================================
// BAIXAR TODAS AS FOTOS DE UM IMÓVEL EM UM ÚNICO .ZIP
// =====================================================================
function extensaoDaUrl(url) {
  const semQuery = url.split('?')[0];
  const match = semQuery.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? match[1].toLowerCase() : 'jpg';
}

function nomeArquivoZipSeguro(nome) {
  return (nome || 'imovel')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'imovel';
}

async function baixarFotosImovelZip(im) {
  const fotos = Array.isArray(im.fotos) ? im.fotos : (im.fotos ? JSON.parse(im.fotos) : []);
  if (!fotos.length) { toast('Este imóvel ainda não tem fotos cadastradas.', true); return; }

  const botao = document.querySelector(`[data-action="imovel-baixar-fotos"][data-id="${im.id}"]`);
  if (botao) botao.textContent = `Baixando 0/${fotos.length}...`;

  const zip = new JSZip();
  let baixadas = 0;
  let falhas = 0;

  await Promise.all(fotos.map(async (url, i) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      const numero = String(i + 1).padStart(2, '0');
      zip.file(`${numero}.${extensaoDaUrl(url)}`, blob);
    } catch (err) {
      falhas += 1;
      console.error('Falha ao baixar foto', url, err);
    } finally {
      baixadas += 1;
      if (botao) botao.textContent = `Baixando ${baixadas}/${fotos.length}...`;
    }
  }));

  if (falhas === fotos.length) {
    toast('Não foi possível baixar nenhuma foto (erro de conexão).', true);
    return;
  }

  if (botao) botao.textContent = 'Compactando...';
  const conteudoZip = await zip.generateAsync({ type: 'blob' });
  const nomeArquivo = `fotos-${nomeArquivoZipSeguro(im.codigo || im.titulo)}.zip`;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(conteudoZip);
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);

  toast(falhas > 0
    ? `Fotos baixadas com ${falhas} foto(s) que falharam.`
    : `${fotos.length} foto(s) baixada(s) em ${nomeArquivo}`);
}

// =====================================================================
// FICHA DO IMÓVEL EM PDF
// =====================================================================
function imagemParaDataUrl(url) {
  return fetch(url)
    .then((r) => r.blob())
    .then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }));
}

async function gerarFichaPdfImovel(im) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const largura = doc.internal.pageSize.getWidth();
  let y = 0;

  doc.setFillColor(11, 30, 61);
  doc.rect(0, 0, largura, 70, 'F');
  doc.setTextColor(255, 106, 26);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Gregório | Meu Lar Imóveis', 32, 42);
  y = 100;

  const foto = firstFoto(im.fotos);
  if (foto) {
    try {
      const dataUrl = await imagemParaDataUrl(foto);
      doc.addImage(dataUrl, 'JPEG', 32, y, largura - 64, 220, undefined, 'FAST');
      y += 240;
    } catch (err) { console.error('Não foi possível carregar a foto na ficha:', err); }
  }

  doc.setTextColor(20, 20, 20);
  doc.setFontSize(18);
  doc.text(im.titulo || 'Imóvel', 32, y);
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(80, 80, 80);
  const endereco = [im.endereco, im.numero, im.bairro, im.cidade, im.estado].filter(Boolean).join(', ');
  if (endereco) { doc.text(endereco, 32, y); y += 16; }
  if (im.codigo) { doc.text(`Código: ${im.codigo}`, 32, y); y += 16; }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 106, 26);
  const valor = im.finalidade === 'locacao' ? im.valor_locacao : im.valor_venda;
  doc.text(valor ? money(valor) : 'Sob consulta', 32, y + 8);
  y += 30;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  const specs = [
    im.quartos ? `${im.quartos} quartos` : null,
    im.suites ? `${im.suites} suítes` : null,
    im.banheiros ? `${im.banheiros} banheiros` : null,
    im.vagas_garagem ? `${im.vagas_garagem} vagas` : null,
    im.area_total ? `${im.area_total}m² área total` : null,
    im.area_construida ? `${im.area_construida}m² construída` : null,
  ].filter(Boolean).join('  ·  ');
  if (specs) { doc.text(specs, 32, y); y += 22; }

  if (im.descricao) {
    const linhas = doc.splitTextToSize(im.descricao, largura - 64);
    doc.text(linhas, 32, y);
    y += linhas.length * 14 + 10;
  }

  if (im.corretor?.nome) {
    y += 10;
    doc.setFont('helvetica', 'bold');
    doc.text('Corretor responsável:', 32, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`${im.corretor.nome}${im.corretor.creci ? ' — CRECI ' + im.corretor.creci : ''}${im.corretor.telefone ? ' — ' + im.corretor.telefone : ''}`, 170, y);
  }

  doc.save(`ficha-imovel-${im.codigo || im.id}.pdf`);
}

// =====================================================================
// LAUDO DE VISTORIA EM PDF (com linhas de assinatura)
// =====================================================================
async function gerarLaudoPdfVistoria(v, itens, fotos) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const largura = doc.internal.pageSize.getWidth();
  const altura = doc.internal.pageSize.getHeight();
  const margemInferior = 70;
  let y = 0;

  function cabecalho() {
    doc.setFillColor(11, 30, 61);
    doc.rect(0, 0, largura, 60, 'F');
    doc.setTextColor(255, 106, 26);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Gregório | Meu Lar Imóveis — Laudo de Vistoria', 32, 38);
  }

  function novaPagina() {
    doc.addPage();
    cabecalho();
    y = 90;
  }

  cabecalho();
  y = 90;

  const endereco = [v.imoveis?.endereco, v.imoveis?.numero, v.imoveis?.bairro, v.imoveis?.cidade, v.imoveis?.estado].filter(Boolean).join(', ');

  doc.setTextColor(20, 20, 20);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(v.imoveis?.titulo || 'Imóvel', 32, y);
  y += 20;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(60, 60, 60);
  if (endereco) { doc.text(endereco, 32, y); y += 16; }

  const linhaInfo = [
    `Tipo de vistoria: ${v.tipo.replace(/_/g, ' ')}`,
    `Status: ${v.status.replace(/_/g, ' ')}`,
  ].join('   ·   ');
  doc.text(linhaInfo, 32, y); y += 16;

  const dataVistoria = v.data_realizada || v.data_agendada;
  if (dataVistoria) { doc.text(`Data: ${dateTime(dataVistoria)}`, 32, y); y += 16; }
  if (v.vistoriador?.nome) { doc.text(`Vistoriador: ${v.vistoriador.nome}`, 32, y); y += 16; }
  if (v.responsavel_acompanhando) { doc.text(`Acompanhado por: ${v.responsavel_acompanhando}`, 32, y); y += 16; }
  if (v.estado_geral) { doc.text(`Estado geral do imóvel: ${v.estado_geral}`, 32, y); y += 16; }

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(11, 30, 61);
  doc.text('Checklist por ambiente', 32, y);
  y += 18;

  if (!itens.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(90, 90, 90);
    doc.text('Nenhum item de checklist registrado.', 32, y);
    y += 16;
  } else {
    doc.setFontSize(10);
    itens.forEach((it) => {
      if (y > altura - margemInferior - 60) novaPagina();
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(20, 20, 20);
      doc.text(`${it.ambiente} — ${it.item}`, 32, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(90, 90, 90);
      doc.text(`(${it.condicao || '—'})`, largura - 100, y);
      y += 13;
      if (it.observacao) {
        const linhasObs = doc.splitTextToSize(it.observacao, largura - 64);
        doc.text(linhasObs, 40, y);
        y += linhasObs.length * 12 + 4;
      } else {
        y += 6;
      }
    });
  }

  if (v.laudo_final) {
    if (y > altura - margemInferior - 100) novaPagina();
    y += 10;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(11, 30, 61);
    doc.text('Laudo final', 32, y);
    y += 18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(20, 20, 20);
    const linhasLaudo = doc.splitTextToSize(v.laudo_final, largura - 64);
    doc.text(linhasLaudo, 32, y);
    y += linhasLaudo.length * 13 + 10;
  }

  // Fotos da vistoria — embutidas direto no PDF (2 por linha, respeitando a
  // proporção de cada imagem), pra não depender do QR code/página pública.
  if (fotos && fotos.length) {
    if (y > altura - margemInferior - 60) novaPagina();
    y += 10;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(11, 30, 61);
    doc.text('Fotos da vistoria', 32, y);
    y += 18;

    const gapColuna = 16;
    const larguraColuna = (largura - 64 - gapColuna) / 2;
    const alturaMaxFoto = 190;
    let colunaAtual = 0;
    let alturaLinhaAtual = 0;

    for (const foto of fotos) {
      let dataUrl;
      try {
        dataUrl = await imagemParaDataUrl(foto.url);
      } catch (err) {
        console.error('Falha ao baixar foto da vistoria para o PDF:', foto.url, err);
        continue;
      }
      const dimensoes = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
        img.onerror = () => resolve({ w: 1, h: 1 });
        img.src = dataUrl;
      });
      let wDesenho = larguraColuna;
      let hDesenho = (dimensoes.h / dimensoes.w) * wDesenho;
      if (hDesenho > alturaMaxFoto) { hDesenho = alturaMaxFoto; wDesenho = (dimensoes.w / dimensoes.h) * hDesenho; }

      if (colunaAtual === 0 && y + hDesenho > altura - margemInferior) novaPagina();

      const x = 32 + colunaAtual * (larguraColuna + gapColuna);
      const formatoImg = (dataUrl.match(/^data:image\/(\w+);/) || [, 'JPEG'])[1].toUpperCase().replace('JPG', 'JPEG');
      try {
        doc.addImage(dataUrl, formatoImg, x, y, wDesenho, hDesenho);
      } catch (err) {
        console.error('Falha ao inserir foto no PDF:', err);
      }
      alturaLinhaAtual = Math.max(alturaLinhaAtual, hDesenho);

      if (colunaAtual === 1) { y += alturaLinhaAtual + 10; alturaLinhaAtual = 0; colunaAtual = 0; }
      else { colunaAtual = 1; }
    }
    if (colunaAtual === 1) y += alturaLinhaAtual + 10;
  }

  // QR code — agora que a página pública existe, volta a complementar as
  // fotos já embutidas acima (útil pra quem quer ver rapidinho no celular
  // sem precisar abrir o PDF inteiro).
  const alturaBlocoQr = 100;
  if (y > altura - alturaBlocoQr - 150) novaPagina();
  y += 14;
  const linkVistoriaPublica = `${SITE_URL_PUBLICO}/vistoria.html?id=${v.id}`;
  try {
    const qrDataUrl = await imagemParaDataUrl(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(linkVistoriaPublica)}`);
    doc.addImage(qrDataUrl, 'PNG', 32, y, 80, 80);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(11, 30, 61);
    doc.text('Veja essa vistoria pelo celular', 124, y + 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    const linhasLink = doc.splitTextToSize(`Aponte a câmera para o QR code ao lado, ou acesse: ${linkVistoriaPublica}`, largura - 156);
    doc.text(linhasLink, 124, y + 36);
  } catch (err) {
    console.error('Não foi possível gerar o QR code:', err);
  }
  y += alturaBlocoQr;

  // Bloco de assinaturas — sempre no final, se não couber vai para nova página
  const alturaAssinaturas = 150;
  if (y > altura - alturaAssinaturas) novaPagina();
  y = Math.max(y + 30, altura - alturaAssinaturas);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  doc.text(`Fazenda Rio Grande/PR, ____ de ______________________ de ${new Date().getFullYear()}.`, 32, y);
  y += 50;

  const metadeLargura = (largura - 64) / 2;
  doc.line(32, y, 32 + metadeLargura - 20, y);
  doc.line(32 + metadeLargura + 20, y, largura - 32, y);
  y += 16;
  doc.setFont('helvetica', 'bold');
  doc.text(assinanteLaudoVistoria(v.tipo), 32, y);
  doc.text('Gregório | Meu Lar Imóveis', 32 + metadeLargura + 20, y);

  doc.save(`laudo-vistoria-${v.imoveis?.titulo ? v.imoveis.titulo.replace(/\s+/g, '-').toLowerCase() : v.id}.pdf`);
}

function desativarImovelForm(id) {
  return `
    <h2>Desativar imóvel</h2>
    <form class="modal-form" id="desativarImovelForm">
      <input type="hidden" id="di-id" value="${id}">
      <div class="form-row full">
        <label>Motivo da desativação</label>
        <textarea required id="di-motivo" rows="3" placeholder="Ex: Proprietário desistiu, imóvel já negociado por fora, etc."></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelDesativarImovel">Cancelar</button>
        <button type="submit" class="btn btn-danger">Desativar</button>
      </div>
    </form>
  `;
}

function bindDesativarImovelForm() {
  $('#cancelDesativarImovel').addEventListener('click', closeModal);
  $('#desativarImovelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#di-id').value;
    const motivo = $('#di-motivo').value.trim();
    if (!motivo) return;
    const { error } = await supabase.from('imoveis').update({ status: 'inativo', motivo_desativacao: motivo }).eq('id', id);
    if (error) { toast('Não foi possível desativar.', true); return; }
    toast('Imóvel desativado e removido do site.');
    closeModal();
    loadImoveis();
  });
}

function bindImovelForm(im = {}) {
  $('#cancelImovel').addEventListener('click', closeModal);

  // Ao sair do campo CEP: busca o endereço oficial (ViaCEP) pra preencher os campos vazios,
  // e já gera latitude/longitude na hora (via Edge Function, evita bloqueio de CORS do Nominatim).
  $('#im-cep').addEventListener('blur', async () => {
    const cepDigitado = $('#im-cep').value.replace(/\D/g, '');
    if (cepDigitado.length !== 8) return;

    const camposStatus = $('#im-cep-status');
    if (camposStatus) { camposStatus.textContent = '🔎 Buscando endereço do CEP...'; camposStatus.hidden = false; }

    let enderecoResolvido = null;
    try {
      const resp = await fetch(`https://viacep.com.br/ws/${cepDigitado}/json/`);
      const dados = await resp.json();
      if (!dados.erro) {
        enderecoResolvido = dados;
        // Só preenche o que estiver vazio — não sobrescreve o que o corretor já digitou.
        if (!$('#im-endereco').value.trim() && dados.logradouro) $('#im-endereco').value = dados.logradouro;
        if (!$('#im-bairro').value.trim() && dados.bairro) $('#im-bairro').value = dados.bairro;
        if (dados.localidade) $('#im-cidade').value = dados.localidade;
        if (dados.uf) $('#im-estado').value = dados.uf;
      }
    } catch { /* segue sem endereço resolvido — geocodificação ainda tenta pelo que já estava preenchido */ }

    if (camposStatus) camposStatus.textContent = '📍 Gerando coordenadas...';
    try {
      const { data: resultado, error: erroFn } = await supabase.functions.invoke('geocodificar-endereco', {
        body: {
          cep: cepDigitado,
          endereco: $('#im-endereco').value.trim(),
          numero: $('#im-numero').value.trim(),
          bairro: $('#im-bairro').value.trim(),
          cidade: $('#im-cidade').value.trim(),
        },
      });
      if (!erroFn && resultado?.encontrado) {
        $('#im-latitude').value = resultado.latitude;
        $('#im-longitude').value = resultado.longitude;
        const aproximado = resultado.precisao === 'bairro' || resultado.precisao === 'cidade';
        if (camposStatus) {
          camposStatus.textContent = aproximado
            ? '📍 Coordenadas geradas (aproximadas — endereço exato não encontrado no mapa).'
            : '✅ Endereço e coordenadas preenchidos automaticamente.';
        }
      } else if (camposStatus) {
        camposStatus.textContent = enderecoResolvido ? '✅ Endereço preenchido. Não foi possível gerar coordenadas.' : '⚠️ CEP não encontrado.';
      }
    } catch {
      if (camposStatus) camposStatus.textContent = '⚠️ Erro ao gerar coordenadas — pode preencher latitude/longitude manualmente.';
    }
    if (camposStatus) setTimeout(() => { camposStatus.hidden = true; }, 4000);
  });

  Array.from($$('.im-portal-check')).forEach((chk) => {
    chk.addEventListener('change', () => {
      const nivel = $(`.im-portal-nivel[data-portal="${chk.dataset.portal}"]`);
      if (nivel) nivel.disabled = !chk.checked;
    });
  });

  $('#im-gerar-descricao-btn').addEventListener('click', async () => {
    const btn = $('#im-gerar-descricao-btn');
    const textoOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Gerando...';
    const parseTagsLocal = (val) => (val || '').split(',').map((s) => s.trim()).filter(Boolean);
    const dados = {
      tipo: $('#im-tipo').value,
      finalidade: $('#im-finalidade').value,
      cidade: $('#im-cidade').value.trim(),
      bairro: $('#im-bairro').value.trim(),
      quartos: $('#im-quartos').value || undefined,
      suites: $('#im-suites').value || undefined,
      banheiros: $('#im-banheiros').value || undefined,
      salas: $('#im-salas').value || undefined,
      vagas_garagem: $('#im-vagas').value || undefined,
      area_total: $('#im-area').value || undefined,
      area_construida: $('#im-area-construida').value || undefined,
      ano_construcao: $('#im-ano').value || undefined,
      valor_venda: $('#im-valor-venda').value || undefined,
      valor_locacao: $('#im-valor-locacao').value || undefined,
      valor_condominio: $('#im-valor-condominio').value || undefined,
      valor_iptu: $('#im-valor-iptu').value || undefined,
      aceita_financiamento: $('#im-financiamento').checked,
      elegivel_mcmv: $('#im-mcmv').checked,
      aceita_permuta: $('#im-permuta').checked,
      imovel_luxo: $('#im-luxo').checked,
      caracteristicas: parseTagsLocal($('#im-caracteristicas').value),
      comodos: parseTagsLocal($('#im-comodos').value),
      proximidades: parseTagsLocal($('#im-proximidades').value),
      pontos_fortes: $('#im-pontos-fortes').value.trim() || undefined,
    };
    try {
      const { data, error } = await supabase.functions.invoke('gerar-descricao-imovel', { body: dados });
      if (error) {
        let mensagem = error.message || 'Erro desconhecido.';
        try {
          const corpo = await error.context?.json?.();
          if (corpo?.error) mensagem = corpo.error;
        } catch { /* ignora */ }
        throw new Error(mensagem);
      }
      if (data?.error) throw new Error(data.error);
      if (!data?.descricao) throw new Error('A IA não retornou nenhum texto.');
      $('#im-descricao').value = data.descricao;
      toast('Descrição gerada com sucesso. Revise antes de salvar.');
    } catch (err) {
      toast('Erro ao gerar descrição: ' + err.message, true);
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  });

  $('#im-novo-proprietario-btn').addEventListener('click', () => {
    $('#im-proprietario-novo').hidden = false;
    $('#im-proprietario').value = '';
    $('#im-prop-nome').focus();
  });
  $('#im-cancelar-novo-proprietario').addEventListener('click', () => {
    $('#im-proprietario-novo').hidden = true;
    $('#im-prop-nome').value = '';
    $('#im-prop-telefone').value = '';
    $('#im-prop-email').value = '';
    $('#im-prop-cpf').value = '';
  });

  let fotosAtuais = Array.isArray(im.fotos) ? [...im.fotos] : [];
  let fotosPendentes = [];
  let capa = null; // { tipo: 'atual'|'pendente', ref: url ou File }

  function renderFotosGrid() {
    const grid = $('#im-fotos-grid');
    const isCapaAtual = (url) => !!(capa && capa.tipo === 'atual' && capa.ref === url);
    const isCapaPendente = (file) => !!(capa && capa.tipo === 'pendente' && capa.ref === file);

    grid.innerHTML =
      fotosAtuais.map((url, i) => `
        <div class="foto-thumb ${isCapaAtual(url) ? 'capa' : ''}">
          <img src="${url}">
          ${isCapaAtual(url)
            ? '<span class="foto-capa-badge">★ Capa</span>'
            : `<button type="button" class="foto-capa-btn" data-idx="${i}" data-tipo="atual" title="Definir como foto principal">★</button>`}
          <button type="button" class="foto-remove" data-idx="${i}" data-tipo="atual">&times;</button>
        </div>
      `).join('') +
      fotosPendentes.map((file, i) => `
        <div class="foto-thumb pendente ${isCapaPendente(file) ? 'capa' : ''}">
          <img src="${URL.createObjectURL(file)}">
          ${isCapaPendente(file)
            ? '<span class="foto-capa-badge">★ Capa</span>'
            : `<button type="button" class="foto-capa-btn" data-idx="${i}" data-tipo="pendente" title="Definir como foto principal">★</button>`}
          <button type="button" class="foto-remove" data-idx="${i}" data-tipo="pendente">&times;</button>
        </div>
      `).join('');
  }
  renderFotosGrid();

  $('#im-fotos-file').addEventListener('change', (e) => {
    fotosPendentes.push(...Array.from(e.target.files));
    e.target.value = '';
    renderFotosGrid();
  });

  $('#im-marca-transparencia').addEventListener('input', (e) => {
    $('#im-marca-transparencia-valor').textContent = e.target.value;
  });

  $('#im-fotos-grid').addEventListener('click', (e) => {
    const idx = Number(e.target.dataset.idx);
    const tipo = e.target.dataset.tipo;

    if (e.target.classList.contains('foto-capa-btn')) {
      capa = tipo === 'atual' ? { tipo: 'atual', ref: fotosAtuais[idx] } : { tipo: 'pendente', ref: fotosPendentes[idx] };
      renderFotosGrid();
      return;
    }

    if (e.target.classList.contains('foto-remove')) {
      if (tipo === 'atual') {
        const removida = fotosAtuais[idx];
        fotosAtuais.splice(idx, 1);
        if (capa && capa.tipo === 'atual' && capa.ref === removida) capa = null;
      } else {
        const removida = fotosPendentes[idx];
        fotosPendentes.splice(idx, 1);
        if (capa && capa.tipo === 'pendente' && capa.ref === removida) capa = null;
      }
      renderFotosGrid();
    }
  });

  $('#imovelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#im-id').value;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    let proprietarioId = $('#im-proprietario').value || null;
    const criandoNovoProprietario = !$('#im-proprietario-novo').hidden;
    if (criandoNovoProprietario) {
      const nomeProp = $('#im-prop-nome').value.trim();
      const telefoneProp = $('#im-prop-telefone').value.trim();
      if (!nomeProp || !telefoneProp) {
        toast('Preencha nome e telefone do novo proprietário (ou clique em "Cancelar novo proprietário").', true);
        btn.disabled = false; btn.textContent = 'Salvar';
        return;
      }
      const emailProp = $('#im-prop-email').value.trim();
      const cpfProp = $('#im-prop-cpf').value.trim();
      const soDigitos = (v) => (v || '').replace(/\D/g, '');
      const telefoneNorm = soDigitos(telefoneProp);
      const cpfNorm = soDigitos(cpfProp);
      const { data: existentes, error: erroBusca } = await supabase.from('pessoas').select('id,nome,telefone,email,cpf_cnpj');
      if (erroBusca) {
        toast('Não foi possível verificar duplicidade do novo proprietário: ' + erroBusca.message, true);
        btn.disabled = false; btn.textContent = 'Salvar';
        return;
      }
      const conflito = (existentes || []).find((ex) =>
        (telefoneNorm && soDigitos(ex.telefone) === telefoneNorm) ||
        (emailProp && ex.email && ex.email.toLowerCase() === emailProp.toLowerCase()) ||
        (cpfNorm && soDigitos(ex.cpf_cnpj) === cpfNorm)
      );
      if (conflito) {
        toast(`Já existe uma pessoa cadastrada com esse telefone, e-mail ou CPF: ${conflito.nome}. Selecione ela na lista de proprietários em vez de cadastrar de novo.`, true);
        btn.disabled = false; btn.textContent = 'Salvar';
        return;
      }
      const { data: novaPessoa, error: erroPessoa } = await supabase.from('pessoas')
        .insert({ nome: nomeProp, telefone: telefoneProp, email: emailProp || null, cpf_cnpj: cpfProp || null, papeis: ['proprietario'], corretor_responsavel_id: currentUsuario?.id || null })
        .select('id').single();
      if (erroPessoa) {
        toast('Erro ao cadastrar o novo proprietário: ' + erroPessoa.message, true);
        btn.disabled = false; btn.textContent = 'Salvar';
        return;
      }
      proprietarioId = novaPessoa.id;
    }

    try {
      const aplicarMarca = $('#im-marca-dagua')?.checked;
      const posicaoMarca = $('#im-marca-posicao')?.value || 'centro';
      const transparenciaMarca = Number($('#im-marca-transparencia')?.value || 50);
      for (const file of fotosPendentes) {
        const arquivoFinal = aplicarMarca ? await aplicarMarcaDagua(file, { posicao: posicaoMarca, transparencia: transparenciaMarca }) : file;
        const url = await uploadImagem(arquivoFinal, 'imoveis');
        if (capa && capa.tipo === 'pendente' && capa.ref === file) capa = { tipo: 'atual', ref: url };
        fotosAtuais.push(url);
      }
      fotosPendentes = [];
    } catch (err) {
      toast('Erro ao enviar fotos: ' + err.message, true);
      btn.disabled = false; btn.textContent = 'Salvar';
      return;
    }

    if (capa && capa.tipo === 'atual') {
      const idxCapa = fotosAtuais.indexOf(capa.ref);
      if (idxCapa > 0) {
        fotosAtuais.splice(idxCapa, 1);
        fotosAtuais.unshift(capa.ref);
      }
    }

    const parseTags = (val) => val.split(',').map((s) => s.trim()).filter(Boolean);

    const payload = {
      fotos: fotosAtuais,
      video_url: $('#im-video-url').value.trim() || null,
      tour_virtual_url: $('#im-tour-virtual').value.trim() || null,
      latitude: $('#im-latitude').value ? Number($('#im-latitude').value) : null,
      longitude: $('#im-longitude').value ? Number($('#im-longitude').value) : null,
      corretor_responsavel_id: $('#im-corretor').value || (!id ? currentUsuario?.id : null) || null,
      proprietario_id: proprietarioId,
      titulo: $('#im-titulo').value.trim(),
      codigo: $('#im-codigo').value.trim() || null,
      situacao: $('#im-situacao').value,
      previsao_entrega: $('#im-previsao-entrega').value || null,
      matricula: $('#im-matricula').value.trim() || null,
      tipo: $('#im-tipo').value,
      finalidade: $('#im-finalidade').value,
      status: $('#im-status').value,
      cidade: $('#im-cidade').value.trim(),
      estado: $('#im-estado').value.trim() || 'PR',
      bairro: $('#im-bairro').value.trim() || null,
      zona: $('#im-zona').value || null,
      endereco: $('#im-endereco').value.trim() || null,
      numero: $('#im-numero').value.trim() || null,
      complemento: $('#im-complemento').value.trim() || null,
      cep: $('#im-cep').value.trim() || null,
      ponto_referencia: $('#im-ponto-referencia').value.trim() || null,
      valor_venda: $('#im-valor-venda').value ? Number($('#im-valor-venda').value) : null,
      valor_locacao: $('#im-valor-locacao').value ? Number($('#im-valor-locacao').value) : null,
      valor_condominio: $('#im-valor-condominio').value ? Number($('#im-valor-condominio').value) : null,
      valor_iptu: $('#im-valor-iptu').value ? Number($('#im-valor-iptu').value) : null,
      quartos: $('#im-quartos').value ? Number($('#im-quartos').value) : null,
      suites: $('#im-suites').value ? Number($('#im-suites').value) : null,
      banheiros: $('#im-banheiros').value ? Number($('#im-banheiros').value) : null,
      salas: $('#im-salas').value ? Number($('#im-salas').value) : null,
      vagas_garagem: $('#im-vagas').value ? Number($('#im-vagas').value) : null,
      ano_construcao: $('#im-ano').value ? Number($('#im-ano').value) : null,
      area_total: $('#im-area').value ? Number($('#im-area').value) : null,
      area_construida: $('#im-area-construida').value ? Number($('#im-area-construida').value) : null,
      terreno_frente: $('#im-terreno-frente').value ? Number($('#im-terreno-frente').value) : null,
      terreno_fundo: $('#im-terreno-fundo').value ? Number($('#im-terreno-fundo').value) : null,
      terreno_lateral_esquerda: $('#im-terreno-esq').value ? Number($('#im-terreno-esq').value) : null,
      terreno_lateral_direita: $('#im-terreno-dir').value ? Number($('#im-terreno-dir').value) : null,
      descricao: $('#im-descricao').value.trim() || null,
      pontos_fortes: $('#im-pontos-fortes').value.trim() || null,
      caracteristicas: parseTags($('#im-caracteristicas').value),
      comodos: parseTags($('#im-comodos').value),
      proximidades: parseTags($('#im-proximidades').value),
      elegivel_mcmv: $('#im-mcmv').checked,
      aceita_financiamento: $('#im-financiamento').checked,
      aceita_permuta: $('#im-permuta').checked,
      imovel_luxo: $('#im-luxo').checked,
      destaque: $('#im-destaque').checked,
      publicado: $('#im-publicado').checked,
      portais_publicacao: Array.from($$('.im-portal-check')).filter((c) => c.checked).map((c) => c.dataset.portal),
      portais_destaque: Array.from($$('.im-portal-check')).filter((c) => c.checked).reduce((acc, c) => {
        acc[c.dataset.portal] = $(`.im-portal-nivel[data-portal="${c.dataset.portal}"]`)?.value || 'simples';
        return acc;
      }, {}),
    };

    const { error } = id
      ? await supabase.from('imoveis').update(payload).eq('id', id)
      : await supabase.from('imoveis').insert(payload);

    if (error) { toast('Erro ao salvar imóvel: ' + error.message, true); console.error(error); btn.disabled = false; btn.textContent = 'Salvar'; return; }
    toast('Imóvel salvo com sucesso.');
    closeModal();
    loadImoveis();
  });
}

// =====================================================================
// PESSOAS
// =====================================================================
const PAPEIS = ['proprietario', 'inquilino', 'comprador', 'vendedor', 'locador', 'construtor', 'incorporadora', 'interessado_compra', 'interessado_locacao'];

let pessoasCache = [];
let pessoasPagina = 1;

async function loadPessoas() {
  const wrap = $('#pessoasCards');
  const { data, error } = await supabase.from('pessoas').select('*, corretor_responsavel:usuarios!corretor_responsavel_id(nome)').order('criado_em', { ascending: false });
  if (error) { wrap.innerHTML = `<p class="empty-state">Erro ao carregar pessoas.</p>`; console.error(error); return; }
  pessoasCache = data || [];
  pessoasPagina = 1;
  renderPessoasTable();
}

function iniciais(nome) {
  const partes = (nome || '').trim().split(/\s+/);
  return ((partes[0]?.[0] || '') + (partes[partes.length - 1]?.[0] || '')).toUpperCase();
}

const PAPEL_LABEL = { proprietario: 'Proprietário', locatario: 'Locatário', inquilino: 'Inquilino', comprador: 'Comprador', vendedor: 'Vendedor', locador: 'Locador', construtor: 'Construtor', incorporadora: 'Incorporadora', interessado_compra: 'Interessado Compra', interessado_locacao: 'Interessado Locação', lead: 'Lead', fiador: 'Fiador' };

function renderPessoasTable() {
  const wrap = $('#pessoasCards');
  const termo = semAcento(($('#pessoasSearch')?.value || '').trim());
  const filtrados = termo
    ? pessoasCache.filter((p) => semAcento([p.nome, p.telefone, p.email, p.cpf_cnpj].filter(Boolean).join(' ')).includes(termo))
    : pessoasCache;

  if (!filtrados.length) { wrap.innerHTML = `<p class="empty-state">${pessoasCache.length ? 'Nenhuma pessoa encontrada para essa busca.' : 'Nenhuma pessoa cadastrada ainda.'}</p>`; return; }

  const visiveis = filtrados.slice(0, pessoasPagina * TAMANHO_PAGINA);

  wrap.innerHTML = visiveis.map((p) => `
    <article class="imovel-card pessoa-card">
      <div class="pessoa-card-avatar">${iniciais(p.nome) || '👤'}</div>
      <div class="imovel-card-body">
        <div class="imovel-card-top">
          <div class="imovel-card-heading">
            <span class="imovel-card-codigo">${p.tipo_pessoa === 'juridica' ? 'Pessoa jurídica' : 'Pessoa física'}${p.cpf_cnpj ? ' · ' + p.cpf_cnpj : ''}</span>
            <h3 class="imovel-card-titulo">${p.nome}</h3>
            <p class="imovel-card-loc">${[p.telefone, p.email].filter(Boolean).join(' · ') || 'Sem contato cadastrado'}</p>
          </div>
        </div>
        ${(p.papeis || []).length ? `<div class="imovel-card-badges">${(p.papeis || []).map((pa) => `<span class="badge-mini">${PAPEL_LABEL[pa] || pa}</span>`).join('')}</div>` : ''}
        <div class="imovel-card-footer">
          <div class="imovel-card-precowrap">
            <span class="imovel-card-meta">${[p.bairro, p.cidade].filter(Boolean).join(', ') || ''}${p.corretor_responsavel?.nome ? ` · Responsável: ${p.corretor_responsavel.nome}` : ''}</span>
          </div>
          <div class="imovel-card-actions">
            <button class="btn btn-ghost btn-sm" data-action="pessoa-edit" data-id="${p.id}">Editar</button>
            ${souGerente ? `<button class="btn btn-danger btn-sm" data-action="pessoa-delete" data-id="${p.id}">Excluir</button>` : ''}
          </div>
        </div>
      </div>
    </article>
  `).join('');

  if (filtrados.length > visiveis.length) {
    wrap.innerHTML += `<div class="imoveis-cards-more"><button class="btn btn-ghost btn-sm" id="pessoasCarregarMais">Carregar mais (${filtrados.length - visiveis.length} restantes)</button></div>`;
    $('#pessoasCarregarMais').addEventListener('click', () => { pessoasPagina += 1; renderPessoasTable(); });
  }
}

$('#pessoasSearch').addEventListener('input', () => { pessoasPagina = 1; renderPessoasTable(); });

async function pessoaForm(p = {}) {
  const papeis = p.papeis || [];
  const { data: corretores } = await supabase.from('usuarios').select('id,nome,ativo').order('nome');
  return `
    <h2>${p.id ? 'Editar pessoa' : 'Nova pessoa'}</h2>
    <form class="modal-form" id="pessoaForm">
      <input type="hidden" id="p-id" value="${p.id || ''}">
      <div class="form-row full"><label>Nome</label><input required id="p-nome" value="${p.nome || ''}"></div>
      <div class="form-row"><label>Corretor responsável${podeVerFinanceiro ? '' : ' (você — só gerente/admin pode transferir)'}</label>
        <select id="p-corretor" ${podeVerFinanceiro ? '' : 'disabled'}>
          <option value="">Sem corretor definido</option>
          ${(corretores || []).filter((c) => c.ativo !== false).map((c) => `<option value="${c.id}" ${c.id === (p.corretor_responsavel_id || (!p.id ? currentUsuario?.id : null)) ? 'selected' : ''}>${c.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Telefone</label><input required id="p-telefone" value="${p.telefone || ''}"></div>
      <div class="form-row"><label>WhatsApp (se for diferente do telefone)</label><input id="p-whatsapp" value="${p.whatsapp || ''}"></div>
      <div class="form-row"><label>E-mail</label><input type="email" id="p-email" value="${p.email || ''}"></div>
      <div class="form-row"><label>Tipo de pessoa</label>
        <select id="p-tipo-pessoa">
          <option value="fisica" ${(!p.tipo_pessoa || p.tipo_pessoa === 'fisica') ? 'selected' : ''}>Física</option>
          <option value="juridica" ${p.tipo_pessoa === 'juridica' ? 'selected' : ''}>Jurídica (construtora/incorporadora)</option>
        </select>
      </div>
      <div class="form-row"><label>CPF/CNPJ</label><input id="p-cpf" value="${p.cpf_cnpj || ''}" placeholder="Só números ou com pontuação"></div>
      <div class="form-row"><label>RG</label><input id="p-rg" value="${p.rg || ''}"></div>
      <div class="form-row"><label>Estado civil</label>
        <select id="p-estado-civil">
          <option value="">—</option>
          ${['Solteiro(a)', 'Casado(a)', 'Divorciado(a)', 'Viúvo(a)', 'União estável'].map((op) => `<option value="${op}" ${p.estado_civil === op ? 'selected' : ''}>${op}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Profissão</label><input id="p-profissao" value="${p.profissao || ''}"></div>
      <div class="form-row"><label>Nacionalidade</label><input id="p-nacionalidade" value="${p.nacionalidade || 'Brasileira'}"></div>
      <div class="form-row full"><label>Endereço completo (rua, número, complemento)</label><input id="p-endereco" value="${p.endereco || ''}"></div>
      <div class="form-row"><label>Cidade</label><input id="p-cidade" value="${p.cidade || ''}"></div>
      <div class="form-row"><label>Bairro</label><input id="p-bairro" value="${p.bairro || ''}"></div>
      <div class="form-row"><label>Estado (UF)</label><input id="p-estado" value="${p.estado || ''}" maxlength="2" style="text-transform:uppercase"></div>
      <div class="form-row"><label>CEP</label><input id="p-cep" value="${p.cep || ''}"></div>
      <div class="form-row full" style="display:flex;gap:16px;flex-wrap:wrap;">
        ${PAPEIS.map((papel) => `
          <label class="check-row"><input type="checkbox" class="p-papel" value="${papel}" ${papeis.includes(papel) ? 'checked' : ''}> ${PAPEL_LABEL[papel] || papel}</label>
        `).join('')}
      </div>
      <div class="form-row full"><label>Observações</label><textarea id="p-obs" rows="2">${p.observacoes || ''}</textarea></div>
      ${podeVerFinanceiro && papeis.includes('proprietario') ? `
      <div class="form-row full" id="acessoPortalWrap">
        ${p.auth_user_id ? `
          <label>Acesso ao Portal do Proprietário</label>
          <p class="imovel-card-meta">✅ Já tem acesso criado, com o e-mail ${p.email || 'cadastrado'}.</p>
          <button type="button" class="btn btn-ghost btn-sm" id="resetarSenhaPortalBtn" data-pessoa-id="${p.id}">🔄 Resetar senha</button>
        ` : `
          <label>Acesso ao Portal do Proprietário</label>
          <p class="imovel-card-meta" style="margin-bottom:6px;">Ainda não tem login. Confirme o e-mail e clique em criar — a senha temporária aparece na hora, pra você passar ao proprietário.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <input id="p-email-acesso" type="email" value="${p.email || ''}" placeholder="e-mail do proprietário" style="flex:1;min-width:220px;">
            <button type="button" class="btn btn-ghost btn-sm" id="criarAcessoPortalBtn" data-pessoa-id="${p.id || ''}">🔑 Criar acesso ao Portal</button>
          </div>
        `}
      </div>` : ''}
      ${p.id ? `
      <div class="form-row full">
        <label>Documentos anexados (RG, CPF, comprovantes...)</label>
        <div class="documentos-lista" id="documentosLista-pessoa-${p.id}"><p class="table-empty">Carregando...</p></div>
        <input type="file" id="documentoFile-pessoa-${p.id}" data-pessoa-id="${p.id}">
      </div>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelPessoa">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  `;
}

// =====================================================================
// DOCUMENTOS E ANEXOS (genérico — pessoa / imóvel / contrato)
// =====================================================================
async function carregarDocumentos(coluna, id) {
  const wrap = $(`#documentosLista-${coluna}-${id}`);
  if (!wrap) return;
  const { data, error } = await supabase.from('documentos').select('*').eq(`${coluna}_id`, id).order('criado_em', { ascending: false });
  if (error) { wrap.innerHTML = '<p class="table-empty">Erro ao carregar documentos.</p>'; return; }
  if (!data.length) { wrap.innerHTML = '<p class="table-empty">Nenhum documento anexado ainda.</p>'; return; }
  wrap.innerHTML = data.map((d) => `
    <div class="documento-item">
      <a href="${d.url}" target="_blank" rel="noopener">📄 ${d.nome}</a>
      ${souGerente ? `<button type="button" class="btn btn-ghost btn-sm" data-action="documento-delete" data-id="${d.id}" data-coluna="${coluna}" data-ref-id="${id}">Excluir</button>` : ''}
    </div>
  `).join('');
}

async function bindUploadDocumento(coluna, id) {
  const input = $(`#documentoFile-${coluna}-${id}`);
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImagem(file, 'documentos');
      const payload = { nome: file.name, url, tipo: file.type || null };
      payload[`${coluna}_id`] = id;
      const { error } = await supabase.from('documentos').insert(payload);
      if (error) throw error;
      toast('Documento anexado.');
      carregarDocumentos(coluna, id);
    } catch (err) {
      toast('Erro ao enviar documento: ' + err.message, true);
    }
    input.value = '';
  });
}

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'documento-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir documentos.', true); return; }
    if (!confirm('Excluir este documento?')) return;
    const { error } = await supabase.from('documentos').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Documento excluído.');
    carregarDocumentos(e.target.dataset.coluna, e.target.dataset.refId);
  }
});

$('#newPessoaBtn').addEventListener('click', async () => { openModal(await pessoaForm()); bindPessoaForm(); });

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'pessoa-edit') {
    const { data: p } = await supabase.from('pessoas').select('*').eq('id', e.target.dataset.id).single();
    if (!p) return;
    openModal(await pessoaForm(p));
    bindPessoaForm();
    carregarDocumentos('pessoa', p.id);
    bindUploadDocumento('pessoa', p.id);
  }
  if (e.target.dataset.action === 'pessoa-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir pessoas.', true); return; }
    if (!confirm('Tem certeza que deseja excluir esta pessoa?')) return;
    const { error } = await supabase.from('pessoas').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Pessoa excluída.');
    loadPessoas();
  }
});

function bindPessoaForm() {
  $('#cancelPessoa').addEventListener('click', closeModal);

  $('#resetarSenhaPortalBtn')?.addEventListener('click', async () => {
    const btn = $('#resetarSenhaPortalBtn');
    const pessoaId = btn.dataset.pessoaId;
    if (!confirm('Isso invalida a senha atual dela e gera uma nova. Confirma?')) return;

    btn.disabled = true;
    btn.textContent = 'Resetando...';
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data: resultado, error } = await supabase.functions.invoke('resetar-senha-proprietario', {
        body: { pessoa_id: pessoaId },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (error || !resultado?.sucesso) {
        toast('Erro: ' + (resultado?.erro || error?.message || 'não foi possível resetar.'), true);
        btn.disabled = false;
        btn.textContent = '🔄 Resetar senha';
        return;
      }
      $('#acessoPortalWrap').innerHTML = `
        <label>Acesso ao Portal do Proprietário</label>
        <p class="imovel-card-meta">✅ Senha resetada! Passe pro proprietário:</p>
        <p style="font-family:monospace;background:var(--navy-800);padding:10px;border-radius:8px;margin-top:6px;">
          Site: imoveisgregorio.com.br/portal-proprietario<br>
          E-mail: ${resultado.email}<br>
          Nova senha: ${resultado.nova_senha}
        </p>
      `;
      toast('Senha resetada com sucesso.');
    } catch (err) {
      toast('Erro ao resetar: ' + err.message, true);
      btn.disabled = false;
      btn.textContent = '🔄 Resetar senha';
    }
  });

  $('#criarAcessoPortalBtn')?.addEventListener('click', async () => {
    const btn = $('#criarAcessoPortalBtn');
    const pessoaId = btn.dataset.pessoaId;
    const email = $('#p-email-acesso').value.trim();
    if (!pessoaId) { toast('Salve a pessoa primeiro, depois abra de novo pra criar o acesso.', true); return; }
    if (!email) { toast('Informe o e-mail do proprietário.', true); return; }

    btn.disabled = true;
    btn.textContent = 'Criando...';
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data: resultado, error } = await supabase.functions.invoke('criar-acesso-proprietario', {
        body: { pessoa_id: pessoaId, email },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (error || !resultado?.sucesso) {
        toast('Erro: ' + (resultado?.erro || error?.message || 'não foi possível criar o acesso.'), true);
        btn.disabled = false;
        btn.textContent = '🔑 Criar acesso ao Portal';
        return;
      }
      $('#acessoPortalWrap').innerHTML = resultado.ja_existia ? `
        <label>Acesso ao Portal do Proprietário</label>
        <p class="imovel-card-meta">✅ Vinculado ao login que já existia com o e-mail ${resultado.email} (mesmo acesso de outra pessoa da família). Os imóveis dela aparecem juntos no mesmo portal, com a mesma senha de sempre.</p>
      ` : `
        <label>Acesso ao Portal do Proprietário</label>
        <p class="imovel-card-meta">✅ Acesso criado! Passe esses dados pro proprietário:</p>
        <p style="font-family:monospace;background:var(--navy-800);padding:10px;border-radius:8px;margin-top:6px;">
          Site: imoveisgregorio.com.br/portal-proprietario<br>
          E-mail: ${resultado.email}<br>
          Senha temporária: ${resultado.senha_temporaria}
        </p>
        <p class="imovel-card-meta">Ele pode trocar a senha depois em "Esqueci minha senha" no próprio portal.</p>
      `;
      toast('Acesso criado com sucesso.');
    } catch (err) {
      toast('Erro ao criar acesso: ' + err.message, true);
      btn.disabled = false;
      btn.textContent = '🔑 Criar acesso ao Portal';
    }
  });

  $('#pessoaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#p-id').value;
    const btn = e.target.querySelector('button[type="submit"]');
    const papeis = Array.from($$('.p-papel')).filter((c) => c.checked).map((c) => c.value);

    const nome = $('#p-nome').value.trim();
    const telefone = $('#p-telefone').value.trim();
    const email = $('#p-email').value.trim() || null;
    const cpf = $('#p-cpf').value.trim() || null;

    const soDigitos = (v) => (v || '').replace(/\D/g, '');
    const telefoneNorm = soDigitos(telefone);
    const cpfNorm = soDigitos(cpf);

    // checagem amigável de duplicidade (telefone / e-mail / CPF) antes de tentar salvar
    btn.disabled = true;
    btn.textContent = 'Verificando...';
    const { data: existentes, error: erroBusca } = await supabase
      .from('pessoas')
      .select('id, nome, telefone, email, cpf_cnpj')
      .neq('id', id || '00000000-0000-0000-0000-000000000000');

    if (erroBusca) {
      toast('Não foi possível verificar duplicidade: ' + erroBusca.message, true);
      btn.disabled = false; btn.textContent = 'Salvar';
      return;
    }

    const conflito = (existentes || []).find((ex) =>
      (telefoneNorm && soDigitos(ex.telefone) === telefoneNorm) ||
      (email && ex.email && ex.email.toLowerCase() === email.toLowerCase()) ||
      (cpfNorm && soDigitos(ex.cpf_cnpj) === cpfNorm)
    );

    if (conflito) {
      toast(`Já existe um cadastro com esse telefone, e-mail ou CPF: ${conflito.nome}.`, true);
      btn.disabled = false; btn.textContent = 'Salvar';
      return;
    }

    btn.textContent = 'Salvando...';
    const payload = {
      nome,
      telefone,
      whatsapp: $('#p-whatsapp').value.trim() || null,
      email,
      tipo_pessoa: $('#p-tipo-pessoa').value,
      cpf_cnpj: cpf,
      rg: $('#p-rg').value.trim() || null,
      estado_civil: $('#p-estado-civil').value || null,
      profissao: $('#p-profissao').value.trim() || null,
      nacionalidade: $('#p-nacionalidade').value.trim() || 'Brasileira',
      endereco: $('#p-endereco').value.trim() || null,
      cidade: $('#p-cidade').value.trim() || null,
      bairro: $('#p-bairro').value.trim() || null,
      estado: $('#p-estado').value.trim().toUpperCase() || null,
      cep: $('#p-cep').value.trim() || null,
      papeis,
      observacoes: $('#p-obs').value.trim() || null,
    };
    payload.corretor_responsavel_id = $('#p-corretor').value || (!id ? currentUsuario?.id : null) || null;

    const { error } = id
      ? await supabase.from('pessoas').update(payload).eq('id', id)
      : await supabase.from('pessoas').insert(payload);

    btn.disabled = false; btn.textContent = 'Salvar';

    if (error) {
      const mensagem = error.code === '23505'
        ? 'Já existe uma pessoa cadastrada com esse telefone, e-mail ou CPF.'
        : 'Erro ao salvar pessoa: ' + error.message;
      toast(mensagem, true);
      console.error(error);
      return;
    }
    toast('Pessoa salva com sucesso.');
    closeModal();
    loadPessoas();
  });
}

// =====================================================================
// VISITAS
// =====================================================================
async function loadVisitas() {
  const tbody = $('#visitasTable tbody');
  const { data, error } = await supabase
    .from('visitas')
    .select('*, imoveis(titulo), leads(nome), usuarios(nome)')
    .order('data_hora', { ascending: true });

  if (error) { tbody.innerHTML = emptyRow(6, 'Erro ao carregar visitas.'); console.error(error); return; }
  if (!data.length) { tbody.innerHTML = emptyRow(6, 'Nenhuma visita agendada ainda.'); return; }

  let corretoresParaReatribuir = [];
  if (podeVerFinanceiro) {
    const { data: cs } = await supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome');
    corretoresParaReatribuir = cs || [];
  }

  tbody.innerHTML = data.map((v) => `
    <tr>
      <td>${dateTime(v.data_hora)}</td>
      <td>${v.imoveis?.titulo || '—'}</td>
      <td>${v.leads?.nome || '—'}</td>
      <td>${podeVerFinanceiro
        ? `<select class="status-select" data-action="visita-reatribuir" data-id="${v.id}">
             <option value="">Sem corretor</option>
             ${corretoresParaReatribuir.map((u) => `<option value="${u.id}" ${u.id === v.corretor_id ? 'selected' : ''}>${u.nome}</option>`).join('')}
           </select>`
        : (v.usuarios?.nome || '—')}</td>
      <td>${statusPill(v.status)}${v.feedback ? ` <span class="visita-feedback" title="${v.feedback.replace(/"/g, '&quot;')}">💬</span>` : ''}</td>
      <td>
        ${v.status === 'agendada' ? `
          <button class="btn btn-ghost btn-sm" data-action="visita-realizada" data-id="${v.id}">Realizada</button>
          <button class="btn btn-ghost btn-sm" data-action="visita-nao-compareceu" data-id="${v.id}">Não compareceu</button>
        ` : ''}
        <button class="btn btn-ghost btn-sm" data-action="visita-reagendar" data-id="${v.id}" data-datahora="${v.data_hora}">Reagendar</button>
        ${v.status !== 'cancelada' ? `<button class="btn btn-danger btn-sm" data-action="visita-delete" data-id="${v.id}">Cancelar</button>` : ''}
      </td>
    </tr>
  `).join('');
}

async function visitaForm() {
  const [{ data: imoveis }, { data: leads }, { data: usuarios }] = await Promise.all([
    supabase.from('imoveis').select('id,titulo').order('titulo'),
    supabase.from('leads').select('id,nome').order('nome'),
    supabase.from('usuarios').select('id,nome').order('nome'),
  ]);

  return `
    <h2>Agendar visita</h2>
    <form class="modal-form" id="visitaForm">
      <div class="form-row full"><label>Imóvel</label>
        <select id="v-imovel" required>
          <option value="">Selecione...</option>
          ${(imoveis || []).map((im) => `<option value="${im.id}">${im.titulo}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Lead</label>
        <select id="v-lead">
          <option value="">Selecione...</option>
          ${(leads || []).map((l) => `<option value="${l.id}">${l.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Corretor${podeVerFinanceiro ? '' : ' (você — só gerência/admin pode transferir)'}</label>
        <select id="v-corretor" ${podeVerFinanceiro ? '' : 'disabled'}>
          <option value="">Selecione...</option>
          ${(usuarios || []).map((u) => `<option value="${u.id}" ${u.id === currentUsuario?.id ? 'selected' : ''}>${u.nome}</option>`).join('')}
        </select>
        ${!usuarios?.length ? '<p style="font-size:.78rem;margin-top:6px;">Nenhum corretor cadastrado na tabela "usuarios" ainda.</p>' : ''}
      </div>
      <div class="form-row full"><label>Data e hora</label><input required type="datetime-local" id="v-datahora"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelVisita">Cancelar</button>
        <button type="submit" class="btn btn-primary">Agendar</button>
      </div>
    </form>
  `;
}

$('#newVisitaBtn').addEventListener('click', async () => {
  openModal(await visitaForm());
  $('#cancelVisita').addEventListener('click', closeModal);
  $('#visitaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      imovel_id: $('#v-imovel').value || null,
      lead_id: $('#v-lead').value || null,
      corretor_id: $('#v-corretor').value || currentUsuario?.id || null,
      data_hora: new Date($('#v-datahora').value).toISOString(),
      status: 'agendada',
    };
    const { error } = await supabase.from('visitas').insert(payload);
    if (error) { toast('Erro ao agendar visita: ' + error.message, true); console.error(error); return; }
    toast('Visita agendada.');
    closeModal();
    loadVisitas();
  });
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset.action === 'visita-reatribuir') {
    if (!podeVerFinanceiro) return;
    const { error } = await supabase.from('visitas').update({ corretor_id: e.target.value || null }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível reatribuir a visita.', true); return; }
    toast('Corretor da visita atualizado.');
    loadVisitas();
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'visita-delete') {
    if (!confirm('Cancelar esta visita?')) return;
    const { error } = await supabase.from('visitas').update({ status: 'cancelada' }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível cancelar.', true); return; }
    toast('Visita cancelada.');
    loadVisitas();
  }
  if (e.target.dataset.action === 'visita-realizada') {
    const feedback = window.prompt('O que o cliente achou do imóvel? (opcional)', '');
    const { error } = await supabase.from('visitas').update({ status: 'realizada', feedback: feedback?.trim() || null }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar.', true); return; }
    toast('Visita marcada como realizada.');
    loadVisitas();
  }
  if (e.target.dataset.action === 'visita-nao-compareceu') {
    const { error } = await supabase.from('visitas').update({ status: 'nao_compareceu' }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar.', true); return; }
    toast('Visita marcada como "não compareceu".');
    loadVisitas();
  }
  if (e.target.dataset.action === 'visita-reagendar') {
    const atual = e.target.dataset.datahora ? new Date(e.target.dataset.datahora) : new Date();
    const sugestao = atual.toISOString().slice(0, 16);
    const novaData = window.prompt('Nova data e hora (AAAA-MM-DDTHH:MM):', sugestao);
    if (!novaData) return;
    const iso = new Date(novaData).toISOString();
    if (isNaN(new Date(novaData).getTime())) { toast('Data inválida.', true); return; }
    const { error } = await supabase.from('visitas').update({ data_hora: iso, status: 'agendada' }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível reagendar.', true); return; }
    toast('Visita reagendada.');
    loadVisitas();
  }
});


// =====================================================================
// VISTORIAS (entrada, saída, periódica, pré-venda)
// =====================================================================
const CONDICOES_ITEM = ['otimo', 'bom', 'regular', 'ruim'];
const TIPOS_VISTORIA_LABELS = {
  entrada: 'Entrada (locatário)',
  saida: 'Saída (locatário)',
  periodica: 'Periódica (locatário)',
  pre_venda: 'Pré-venda (proprietário/vendedor)',
  captacao_locacao: 'Captação para locação — novo imóvel (proprietário)',
};
function labelTipoVistoria(tipo) { return TIPOS_VISTORIA_LABELS[tipo] || tipo.replace(/_/g, ' '); }
function assinanteLaudoVistoria(tipo) {
  if (tipo === 'captacao_locacao') return 'Proprietário';
  if (tipo === 'pre_venda') return 'Proprietário / Vendedor';
  return 'Locatário';
}

// em_andamento e agendada primeiro (precisam de ação); concluída/cancelada no final.
const VISTORIA_STATUS_PRIORIDADE = { em_andamento: 0, agendada: 1, concluida: 2, cancelada: 3 };
let vistoriasCache = [];

async function loadVistorias() {
  const wrap = $('#vistoriasCards');
  const { data, error } = await supabase
    .from('vistorias')
    .select('*, imoveis(titulo, bairro, cidade), usuarios(nome)')
    .order('criado_em', { ascending: false });
  if (error) { wrap.innerHTML = `<p class="empty-state">Erro ao carregar vistorias.</p>`; console.error(error); return; }

  vistoriasCache = (data || []).slice().sort((a, b) => {
    const pa = VISTORIA_STATUS_PRIORIDADE[a.status] ?? 1.5;
    const pb = VISTORIA_STATUS_PRIORIDADE[b.status] ?? 1.5;
    if (pa !== pb) return pa - pb;
    const da = a.data_agendada || a.data_realizada || a.criado_em;
    const db = b.data_agendada || b.data_realizada || b.criado_em;
    return new Date(db) - new Date(da);
  });
  renderVistoriasCards();
}

function renderVistoriasCards() {
  const wrap = $('#vistoriasCards');
  const termo = semAcento(($('#vistoriasSearch')?.value || '').trim());
  const filtrados = termo
    ? vistoriasCache.filter((v) => semAcento([v.imoveis?.titulo, v.usuarios?.nome].filter(Boolean).join(' ')).includes(termo))
    : vistoriasCache;

  if (!filtrados.length) { wrap.innerHTML = `<p class="empty-state">${vistoriasCache.length ? 'Nenhuma vistoria encontrada para essa busca.' : 'Nenhuma vistoria cadastrada ainda.'}</p>`; return; }

  wrap.innerHTML = filtrados.map((v) => {
    const localizacao = [v.imoveis?.bairro, v.imoveis?.cidade].filter(Boolean).join(' — ');
    const dataLabel = v.data_realizada ? `Realizada em ${dateTime(v.data_realizada)}` : (v.data_agendada ? `Agendada para ${dateTime(v.data_agendada)}` : 'Sem data definida');
    return `
      <article class="imovel-card">
        <div class="imovel-card-body" style="padding-left:2px;">
          <div class="imovel-card-top">
            <div class="imovel-card-heading">
              <span class="imovel-card-codigo">${labelTipoVistoria(v.tipo)}</span>
              <h3 class="imovel-card-titulo">${v.imoveis?.titulo || 'Imóvel não vinculado'}</h3>
              <p class="imovel-card-loc">${localizacao ? localizacao + ' · ' : ''}${dataLabel}</p>
            </div>
            ${statusPill(v.status)}
          </div>
          <div class="imovel-card-footer">
            <div class="imovel-card-precowrap">
              <span class="imovel-card-meta">Vistoriador: ${v.usuarios?.nome || 'Não definido'}</span>
            </div>
            <div class="imovel-card-actions">
              <button class="btn btn-ghost btn-sm" data-action="vistoria-abrir" data-id="${v.id}">Abrir</button>
              ${souGerente ? `<button class="btn btn-danger btn-sm" data-action="vistoria-delete" data-id="${v.id}">Excluir</button>` : ''}
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

$('#vistoriasSearch')?.addEventListener('input', renderVistoriasCards);

async function vistoriaForm() {
  const [{ data: imoveis }, { data: usuarios }] = await Promise.all([
    supabase.from('imoveis').select('id,titulo').order('titulo'),
    supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome'),
  ]);
  return `
    <h2>Nova vistoria</h2>
    <form class="modal-form" id="vistoriaForm">
      <div class="form-row full"><label>Imóvel</label>
        <select id="vi-imovel" required>
          <option value="">Selecione...</option>
          ${(imoveis || []).map((im) => `<option value="${im.id}">${im.titulo}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Tipo</label>
        <select id="vi-tipo">
          <option value="entrada">Entrada (locatário)</option>
          <option value="saida">Saída (locatário)</option>
          <option value="periodica">Periódica (locatário)</option>
          <option value="pre_venda">Pré-venda (proprietário/vendedor)</option>
          <option value="captacao_locacao">Captação para locação — novo imóvel (proprietário)</option>
        </select>
      </div>
      <div class="form-row"><label>Vistoriador</label>
        <select id="vi-vistoriador">
          <option value="">Selecione...</option>
          ${(usuarios || []).map((u) => `<option value="${u.id}">${u.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Data agendada</label><input type="datetime-local" id="vi-data-agendada"></div>
      <div class="form-row full"><label>Responsável acompanhando (inquilino/proprietário)</label><input id="vi-responsavel"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelVistoria">Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar vistoria</button>
      </div>
    </form>
  `;
}

$('#newVistoriaBtn').addEventListener('click', async () => {
  openModal(await vistoriaForm());
  $('#cancelVistoria').addEventListener('click', closeModal);
  $('#vistoriaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      imovel_id: $('#vi-imovel').value,
      tipo: $('#vi-tipo').value,
      vistoriador_id: $('#vi-vistoriador').value || null,
      data_agendada: $('#vi-data-agendada').value ? new Date($('#vi-data-agendada').value).toISOString() : null,
      responsavel_acompanhando: $('#vi-responsavel').value.trim() || null,
      status: 'agendada',
    };
    const { error } = await supabase.from('vistorias').insert(payload);
    if (error) { toast('Erro ao criar vistoria: ' + error.message, true); console.error(error); return; }
    toast('Vistoria criada.');
    closeModal();
    loadVistorias();
  });
});

async function carregarItensVistoria(vistoriaId) {
  const { data, error } = await supabase.from('vistoria_itens').select('*').eq('vistoria_id', vistoriaId).order('criado_em');
  const wrap = $('#vistoriaItensLista');
  if (!wrap) return;
  if (error) { wrap.innerHTML = '<p class="table-empty">Erro ao carregar checklist.</p>'; return; }
  if (!data.length) { wrap.innerHTML = '<p class="table-empty">Nenhum item no checklist ainda.</p>'; return; }
  wrap.innerHTML = data.map((it) => `
    <div class="vistoria-item-linha">
      <strong>${it.ambiente}</strong> — ${it.item}
      <span class="status-pill status-${it.condicao || 'regular'}">${it.condicao || '—'}</span>
      ${it.observacao ? `<div class="interacao-texto">${it.observacao}</div>` : ''}
    </div>
  `).join('');
}

async function carregarFotosVistoria(vistoriaId) {
  const { data, error } = await supabase.from('vistoria_fotos').select('*').eq('vistoria_id', vistoriaId).order('criado_em');
  const wrap = $('#vistoriaFotosLista');
  if (!wrap) return;
  if (error || !data.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = data.map((f) => `<div class="foto-thumb"><img src="${f.url}" alt=""></div>`).join('');
}

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'vistoria-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir vistorias.', true); return; }
    if (!confirm('Excluir esta vistoria e todo o checklist/fotos associados?')) return;
    const { error } = await supabase.from('vistorias').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Vistoria excluída.');
    loadVistorias();
  }
  if (e.target.dataset.action === 'vistoria-abrir') {
    const { data: v } = await supabase
      .from('vistorias')
      .select('*, imoveis(titulo, endereco, numero, bairro, cidade, estado), vistoriador:usuarios!vistoriador_id(nome)')
      .eq('id', e.target.dataset.id)
      .single();
    if (!v) return;
    openModal(`
      <h2>Vistoria — ${v.imoveis?.titulo || ''}</h2>
      <p><strong>Tipo:</strong> ${labelTipoVistoria(v.tipo)} · <strong>Status:</strong> ${v.status.replace(/_/g, ' ')}</p>
      <button type="button" class="btn btn-outline btn-sm" id="btnBaixarLaudoVistoria" style="margin-bottom:14px;">📄 Baixar laudo (PDF) para assinatura</button>
      <form class="modal-form" id="vistoriaStatusForm">
        <input type="hidden" id="vs-id" value="${v.id}">
        <div class="form-row"><label>Status</label>
          <select id="vs-status">
            <option value="agendada" ${v.status === 'agendada' ? 'selected' : ''}>Agendada</option>
            <option value="em_andamento" ${v.status === 'em_andamento' ? 'selected' : ''}>Em andamento</option>
            <option value="concluida" ${v.status === 'concluida' ? 'selected' : ''}>Concluída</option>
            <option value="cancelada" ${v.status === 'cancelada' ? 'selected' : ''}>Cancelada</option>
          </select>
        </div>
        <div class="form-row"><label>Estado geral do imóvel</label><input id="vs-estado-geral" value="${v.estado_geral || ''}"></div>
        <div class="form-row full"><label>Laudo final</label><textarea id="vs-laudo" rows="2">${v.laudo_final || ''}</textarea></div>
        <div class="modal-actions"><button type="submit" class="btn btn-primary btn-sm">Salvar vistoria</button></div>
      </form>

      <h3 style="margin-top:18px;">Checklist por ambiente</h3>
      <div class="vistoria-itens-lista" id="vistoriaItensLista"><p class="table-empty">Carregando...</p></div>
      <form class="modal-form" id="vistoriaItemForm" style="margin-top:8px;">
        <div class="form-row"><label>Ambiente</label><input id="vit-ambiente" required placeholder="Ex: Cozinha"></div>
        <div class="form-row"><label>Item</label><input id="vit-item" required placeholder="Ex: Piso"></div>
        <div class="form-row"><label>Condição</label>
          <select id="vit-condicao">${CONDICOES_ITEM.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
        </div>
        <div class="form-row full"><label>Observação</label><input id="vit-observacao"></div>
        <div class="modal-actions"><button type="submit" class="btn btn-primary btn-sm">Adicionar item</button></div>
      </form>

      <h3 style="margin-top:18px;">Fotos da vistoria</h3>
      <div class="fotos-grid" id="vistoriaFotosLista"></div>
      <input type="file" id="vistoriaFotoFile" accept="image/*" multiple>
    `);

    carregarItensVistoria(v.id);
    carregarFotosVistoria(v.id);

    $('#btnBaixarLaudoVistoria').addEventListener('click', async (ev) => {
      const btn = ev.target;
      btn.disabled = true;
      const textoOriginal = btn.textContent;
      btn.textContent = 'Gerando...';
      try {
        const { data: itens } = await supabase.from('vistoria_itens').select('*').eq('vistoria_id', v.id).order('criado_em');
        const { data: fotos } = await supabase.from('vistoria_fotos').select('*').eq('vistoria_id', v.id).order('criado_em');
        await gerarLaudoPdfVistoria(v, itens || [], fotos || []);
      } catch (err) {
        toast('Erro ao gerar o laudo: ' + err.message, true);
        console.error(err);
      }
      btn.disabled = false;
      btn.textContent = textoOriginal;
    });

    $('#vistoriaStatusForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const payload = {
        status: $('#vs-status').value,
        estado_geral: $('#vs-estado-geral').value.trim() || null,
        laudo_final: $('#vs-laudo').value.trim() || null,
      };
      if (payload.status === 'concluida' && !v.data_realizada) payload.data_realizada = new Date().toISOString();
      const { error } = await supabase.from('vistorias').update(payload).eq('id', v.id);
      if (error) { toast('Não foi possível salvar.', true); return; }
      toast('Vistoria atualizada.');
      loadVistorias();
    });

    $('#vistoriaItemForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const payload = {
        vistoria_id: v.id,
        ambiente: $('#vit-ambiente').value.trim(),
        item: $('#vit-item').value.trim(),
        condicao: $('#vit-condicao').value,
        observacao: $('#vit-observacao').value.trim() || null,
      };
      const { error } = await supabase.from('vistoria_itens').insert(payload);
      if (error) { toast('Não foi possível adicionar o item.', true); console.error(error); return; }
      $('#vit-ambiente').value = ''; $('#vit-item').value = ''; $('#vit-observacao').value = '';
      carregarItensVistoria(v.id);
    });

    $('#vistoriaFotoFile').addEventListener('change', async (ev) => {
      const files = Array.from(ev.target.files || []);
      if (!files.length) return;
      for (const file of files) {
        try {
          const url = await uploadImagem(file, 'vistorias');
          await supabase.from('vistoria_fotos').insert({ vistoria_id: v.id, url });
        } catch (err) {
          toast('Erro ao enviar foto: ' + err.message, true);
        }
      }
      carregarFotosVistoria(v.id);
    });
  }
});

// =====================================================================
// CONTRATOS
// =====================================================================
// Prioridade na lista: inadimplente e ativo sempre primeiro (precisam de atenção);
// encerrado/cancelado vão para o final.
const CONTRATO_STATUS_PRIORIDADE = { inadimplente: 0, ativo: 1, encerrado: 2, cancelado: 3 };
let contratosCache = [];

async function loadContratos() {
  const wrap = $('#contratosCards');
  const { data, error } = await supabase
    .from('contratos')
    .select('*, imoveis(titulo, bairro, cidade), pessoas!contratos_comprador_locatario_id_fkey(nome), usuarios(nome)')
    .order('criado_em', { ascending: false });

  if (error) { wrap.innerHTML = `<p class="empty-state">Erro ao carregar contratos.</p>`; console.error(error); return; }

  contratosCache = (data || []).slice().sort((a, b) => {
    const pa = CONTRATO_STATUS_PRIORIDADE[a.status] ?? 1.5;
    const pb = CONTRATO_STATUS_PRIORIDADE[b.status] ?? 1.5;
    if (pa !== pb) return pa - pb;
    return new Date(b.data_inicio || b.criado_em) - new Date(a.data_inicio || a.criado_em);
  });
  renderContratosCards();
}

function renderContratosCards() {
  const wrap = $('#contratosCards');
  const banner = $('#contratosAlertaBanner');
  const termo = semAcento(($('#contratosSearch')?.value || '').trim());
  let filtrados = termo
    ? contratosCache.filter((c) => semAcento([c.imoveis?.titulo, c.pessoas?.nome, c.usuarios?.nome].filter(Boolean).join(' ')).includes(termo))
    : contratosCache;

  if (filtroContratosSemRepasse) {
    filtrados = filtrados.filter((c) => c.tipo === 'locacao' && c.status === 'ativo' && !c.dia_repasse);
  }
  if (banner) {
    banner.hidden = !filtroContratosSemRepasse;
    if (filtroContratosSemRepasse) {
      banner.innerHTML = `<span>🔔 Mostrando <strong>${filtrados.length}</strong> contrato${filtrados.length === 1 ? '' : 's'} de locação ativo${filtrados.length === 1 ? '' : 's'} sem dia de repasse.</span><button type="button" class="btn btn-ghost btn-sm" data-action="limpar-filtro-alerta" data-tela="contratos">Limpar filtro</button>`;
    }
  }

  if (!filtrados.length) { wrap.innerHTML = `<p class="empty-state">${filtroContratosSemRepasse ? 'Nenhum contrato pendente — tudo corrigido! 🎉' : (contratosCache.length ? 'Nenhum contrato encontrado para essa busca.' : 'Nenhum contrato cadastrado ainda.')}</p>`; return; }

  wrap.innerHTML = filtrados.map((c) => {
    const localizacao = [c.imoveis?.bairro, c.imoveis?.cidade].filter(Boolean).join(' — ');
    const periodo = c.tipo === 'locacao'
      ? `${c.data_inicio ? new Date(c.data_inicio + 'T00:00:00').toLocaleDateString('pt-BR') : '—'} até ${c.data_fim ? new Date(c.data_fim + 'T00:00:00').toLocaleDateString('pt-BR') : 'indeterminado'}`
      : (c.data_inicio ? new Date(c.data_inicio + 'T00:00:00').toLocaleDateString('pt-BR') : '—');

    const badges = [`<span class="badge-mini">${c.tipo === 'locacao' ? 'Locação' : 'Venda'}</span>`];
    if (c.tipo === 'locacao' && c.taxa_administracao_percentual) badges.push(`<span class="badge-mini">Taxa adm.: ${c.taxa_administracao_percentual}%</span>`);

    return `
      <article class="imovel-card">
        <div class="imovel-card-body" style="padding-left:2px;">
          <div class="imovel-card-top">
            <div class="imovel-card-heading">
              <span class="imovel-card-codigo">${periodo}</span>
              <h3 class="imovel-card-titulo">${c.imoveis?.titulo || 'Imóvel não vinculado'}</h3>
              <p class="imovel-card-loc">${localizacao || ''} ${c.pessoas?.nome ? `· Cliente: ${c.pessoas.nome}` : ''}</p>
            </div>
            ${statusPill(c.status)}
          </div>
          <div class="imovel-card-badges">${badges.join('')}</div>
          <div class="imovel-card-footer">
            <div class="imovel-card-precowrap">
              <strong class="imovel-card-preco">${money(c.valor)}${c.tipo === 'locacao' ? '/mês' : ''}</strong>
              <span class="imovel-card-meta">Corretor: ${c.usuarios?.nome || '—'} · Comissão: ${money(c.comissao_valor)}${c.comissao_percentual ? ` (${c.comissao_percentual}%)` : ''}</span>
            </div>
            <div class="imovel-card-actions">
              <button class="btn btn-ghost btn-sm" data-action="contrato-edit" data-id="${c.id}">Editar</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

$('#contratosSearch')?.addEventListener('input', renderContratosCards);

async function contratoForm(c = {}) {
  const [{ data: imoveis }, { data: pessoas }, { data: corretores }] = await Promise.all([
    supabase.from('imoveis').select('id,titulo').order('titulo'),
    supabase.from('pessoas').select('id,nome').order('nome'),
    supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome'),
  ]);

  return `
    <h2 style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <span>${c.id ? 'Editar contrato' : 'Novo contrato'}</span>
      ${c.id && c.tipo === 'locacao' ? `<button type="button" class="btn btn-ghost btn-sm" id="c-renovar" data-id="${c.id}" data-fim-atual="${c.data_fim || ''}" data-valor-atual="${c.valor || ''}" style="font-weight:400; font-size:.8rem;">🔄 Renovar contrato</button>` : ''}
    </h2>
    <form class="modal-form" id="contratoForm">
      <input type="hidden" id="c-id" value="${c.id || ''}">
      <div class="form-row full"><label>Imóvel</label>
        <select id="c-imovel" required>
          <option value="">Selecione...</option>
          ${(imoveis || []).map((im) => `<option value="${im.id}" ${im.id === c.imovel_id ? 'selected' : ''}>${im.titulo}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Tipo</label>
        <select id="c-tipo">
          <option value="venda" ${c.tipo === 'venda' ? 'selected' : ''}>Venda</option>
          <option value="locacao" ${c.tipo === 'locacao' ? 'selected' : ''}>Locação</option>
        </select>
      </div>
      <div class="form-row"><label>Status</label>
        <select id="c-status">
          <option value="ativo" ${c.status === 'ativo' ? 'selected' : ''}>Ativo</option>
          <option value="encerrado" ${c.status === 'encerrado' ? 'selected' : ''}>Encerrado</option>
          <option value="cancelado" ${c.status === 'cancelado' ? 'selected' : ''}>Cancelado</option>
          <option value="inadimplente" ${c.status === 'inadimplente' ? 'selected' : ''}>Inadimplente</option>
        </select>
      </div>
      <div class="form-row full"><label>Comprador / Locatário</label>
        <select id="c-comprador" required>
          <option value="">Selecione...</option>
          ${(pessoas || []).map((p) => `<option value="${p.id}" ${p.id === c.comprador_locatario_id ? 'selected' : ''}>${p.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Vendedor / Locador</label>
        <select id="c-vendedor">
          <option value="">Selecione...</option>
          ${(pessoas || []).map((p) => `<option value="${p.id}" ${p.id === c.vendedor_locador_id ? 'selected' : ''}>${p.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Corretor responsável pelo negócio${podeVerFinanceiro ? '' : ' (você — só gerência/admin pode transferir)'}</label>
        <select id="c-corretor" ${podeVerFinanceiro ? '' : 'disabled'}>
          <option value="">Selecione...</option>
          ${(corretores || []).map((u) => `<option value="${u.id}" ${u.id === (c.corretor_id || (!c.id ? currentUsuario?.id : null)) ? 'selected' : ''}>${u.nome}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Dia do repasse ao proprietário</label>
        <select id="c-dia-repasse">
          <option value="">Não definido</option>
          <option value="2" ${c.dia_repasse === 2 ? 'selected' : ''}>Dia 02</option>
          <option value="12" ${c.dia_repasse === 12 ? 'selected' : ''}>Dia 12</option>
          <option value="22" ${c.dia_repasse === 22 ? 'selected' : ''}>Dia 22</option>
        </select>
      </div>
      <div class="form-row"><label>Valor (R$)</label><input required type="number" id="c-valor" value="${c.valor || ''}"></div>
      <div class="form-row"><label>Data início</label><input required type="date" id="c-inicio" value="${c.data_inicio || ''}"></div>
      <div class="form-row"><label>Data fim (locação)</label><input type="date" id="c-fim" value="${c.data_fim || ''}"></div>
      <div class="form-row"><label>Dia de vencimento do aluguel (locação)</label><input type="number" min="1" max="31" id="c-dia-vencimento" value="${c.dia_vencimento ?? ''}" placeholder="ex: 5"></div>
      <div class="form-row"><label>Multa por atraso (%)</label><input type="number" step="0.1" id="c-multa" value="${c.multa_percentual ?? 2}"></div>
      <div class="form-row"><label>Juros diário (%)</label><input type="number" step="0.1" id="c-juros" value="${c.juros_diario_percentual ?? 1}"></div>
      <p class="full" style="font-size:.75rem;color:var(--gray-text);margin:-6px 0 4px;">Estes são os percentuais usados <em>se</em> você escolher cobrar a multa/juros. Não é automático: em Financeiro, cada cobrança em atraso tem o botão "Cobrar multa/juros".</p>
      <div class="form-row"><label>Taxa de administração (%)</label><input type="number" step="0.1" id="c-taxa-adm" value="${c.taxa_administracao_percentual ?? 10}"></div>
      <div class="form-row full" style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="c-retem-1-aluguel" ${(c.retem_primeiro_aluguel ?? true) ? 'checked' : ''} style="width:auto;">
        <label for="c-retem-1-aluguel" style="margin:0;">1º aluguel 100% para a imobiliária (não gera repasse no mês de início do contrato)</label>
      </div>
      <div class="form-row"><label>Comissão do corretor (%)</label><input type="number" step="0.1" id="c-comissao-pct" value="${c.comissao_percentual ?? ''}"></div>
      <div class="form-row"><label>Comissão do corretor (R$) — calculada, pode ajustar</label><input type="number" step="0.01" id="c-comissao-valor" value="${c.comissao_valor ?? ''}"></div>
      <div class="form-row full"><label>Observações</label><textarea id="c-obs" rows="2">${c.observacoes || ''}</textarea></div>
      ${c.id ? `
      <div class="form-row full">
        <label>Documentos anexados</label>
        <div id="contratoArquivosLista" class="contrato-arquivos-lista"><p class="dash-vazio">Carregando...</p></div>
        <div class="contrato-arquivos-upload">
          <select id="ca-categoria">
            <option value="contrato_assinado">Contrato assinado</option>
            <option value="documentacao_proprietario">Documentação do proprietário</option>
            <option value="documentacao_inquilino">Documentação do inquilino</option>
            <option value="vistoria">Vistoria</option>
            <option value="outro">Outro</option>
          </select>
          <input type="file" id="ca-arquivo">
          <button type="button" class="btn btn-ghost btn-sm" id="ca-upload-btn">Enviar arquivo</button>
        </div>
      </div>
      ` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelContrato">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  `;
}

$('#newContratoBtn').addEventListener('click', async () => {
  openModal(await contratoForm());
  bindContratoForm();
  ligarCalculoComissao();
});

function ligarCalculoComissao() {
  const valorEl = $('#c-valor');
  const pctEl = $('#c-comissao-pct');
  const valorComissaoEl = $('#c-comissao-valor');
  const recalcular = () => {
    const valor = Number(valorEl.value) || 0;
    const pct = Number(pctEl.value) || 0;
    if (pct > 0) valorComissaoEl.value = (valor * pct / 100).toFixed(2);
  };
  valorEl.addEventListener('input', recalcular);
  pctEl.addEventListener('input', recalcular);
}

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'contrato-edit') {
    const { data: c } = await supabase.from('contratos').select('*').eq('id', e.target.dataset.id).single();
    if (!c) return;
    openModal(await contratoForm(c));
    bindContratoForm();
    ligarCalculoComissao();
  }
});

function abrirRenovarContratoForm(id, fimAtualIso, valorAtual) {
  let novoFimSugerido = '';
  if (fimAtualIso) {
    const [ano, mes, dia] = fimAtualIso.split('-').map(Number);
    const d = new Date(ano, (mes - 1) + 12, dia);
    novoFimSugerido = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  openModal(`
    <h2>Renovar contrato</h2>
    <p class="dash-linha-sub" style="margin-bottom:14px;">Ajusta o valor do aluguel e estende o prazo por mais 12 meses (data sugerida automaticamente, mas pode mudar). O histórico do valor/prazo anterior fica registrado sozinho na Auditoria.</p>
    <form id="renovarContratoForm">
      <div class="form-row full"><label>Novo valor do aluguel (R$)</label><input type="text" id="renov-valor" value="${valorAtual || ''}" required placeholder="Ex: 1.800,00"></div>
      <div class="form-row full"><label>Nova data de término</label><input type="date" id="renov-fim" value="${novoFimSugerido}" required></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelRenovarContrato">Cancelar</button>
        <button type="submit" class="btn btn-primary">Confirmar renovação</button>
      </div>
    </form>
  `, { persistente: false });
  $('#cancelRenovarContrato').addEventListener('click', closeModal);

  $('#renovarContratoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const novoValor = $('#renov-valor').value.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
    const novoFim = $('#renov-fim').value;
    if (!novoValor || !novoFim) { toast('Preencha valor e data.', true); return; }
    btn.disabled = true; btn.textContent = 'Salvando...';
    const { error } = await supabase.from('contratos').update({ valor: novoValor, data_fim: novoFim }).eq('id', id);
    if (error) { toast('Erro ao renovar: ' + error.message, true); btn.disabled = false; btn.textContent = 'Confirmar renovação'; return; }
    toast('Contrato renovado com sucesso.');
    closeModal();
    loadContratos();
  });
}

document.addEventListener('click', (e) => {
  const btnRenovar = e.target.closest('#c-renovar');
  if (btnRenovar) abrirRenovarContratoForm(btnRenovar.dataset.id, btnRenovar.dataset.fimAtual, btnRenovar.dataset.valorAtual);
});

function bindContratoForm() {
  $('#cancelContrato').addEventListener('click', closeModal);

  const contratoId = $('#c-id').value;
  if (contratoId) carregarArquivosContrato(contratoId);

  $('#contratoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#c-id').value;
    const statusAnterior = c.status || null;
    const payload = {
      imovel_id: $('#c-imovel').value,
      tipo: $('#c-tipo').value,
      status: $('#c-status').value,
      comprador_locatario_id: $('#c-comprador').value,
      vendedor_locador_id: $('#c-vendedor').value || null,
      corretor_id: $('#c-corretor').value || (!id ? currentUsuario?.id : null) || null,
      valor: Number($('#c-valor').value),
      data_inicio: $('#c-inicio').value,
      data_fim: $('#c-fim').value || null,
      dia_repasse: $('#c-dia-repasse').value ? Number($('#c-dia-repasse').value) : null,
      dia_vencimento: $('#c-dia-vencimento').value ? Number($('#c-dia-vencimento').value) : null,
      multa_percentual: Number($('#c-multa').value),
      juros_diario_percentual: Number($('#c-juros').value),
      taxa_administracao_percentual: Number($('#c-taxa-adm').value),
      retem_primeiro_aluguel: $('#c-retem-1-aluguel').checked,
      comissao_percentual: $('#c-comissao-pct').value ? Number($('#c-comissao-pct').value) : null,
      comissao_valor: $('#c-comissao-valor').value ? Number($('#c-comissao-valor').value) : null,
      observacoes: $('#c-obs').value.trim() || null,
    };

    const { error } = id
      ? await supabase.from('contratos').update(payload).eq('id', id)
      : await supabase.from('contratos').insert(payload);

    if (error) { toast('Erro ao salvar contrato: ' + error.message, true); console.error(error); return; }

    // Contrato de locação virou encerrado/cancelado agora: qualquer cobrança já gerada
    // e ainda não paga fica sem repasse futuro de verdade, e ficava aparecendo pra
    // sempre no financeiro como se fosse ativa (caso real: Gregório, 22/09/2026).
    // Pergunta na hora se o inquilino ainda deve — se não deve, cancela já.
    const virouEncerradoOuCancelado = id && payload.tipo === 'locacao'
      && ['encerrado', 'cancelado'].includes(payload.status) && statusAnterior !== payload.status;

    if (virouEncerradoOuCancelado) {
      const { data: emAberto } = await supabase
        .from('cobrancas')
        .select('*')
        .eq('contrato_id', id)
        .is('data_pagamento', null);

      if (emAberto && emAberto.length > 0) {
        const total = emAberto.reduce((s, cb) => s + Number(cb.valor_base), 0);
        const qtd = emAberto.length;
        const inquilinoDeve = confirm(
          `Este contrato tem ${qtd} cobrança${qtd > 1 ? 's' : ''} em aberto, totalizando ${money(total)}.\n\n` +
          `O inquilino ainda deve esse valor?\n\n` +
          `OK = Sim, ele deve (a cobrança continua aparecendo no financeiro)\n` +
          `Cancelar = Não deve nada (a cobrança é cancelada agora)`
        );
        if (!inquilinoDeve) {
          await supabase.from('auditoria').insert(
            emAberto.map((cb) => ({
              tabela: 'cobrancas', registro_id: cb.id, acao: 'delete',
              usuario_nome: currentUsuario?.nome || null,
              dados_antes: cb, dados_depois: null,
            }))
          );
          await supabase.from('cobrancas').delete().in('id', emAberto.map((cb) => cb.id));
          toast('Contrato encerrado e cobrança(s) em aberto cancelada(s).');
        } else {
          toast('Contrato encerrado. A(s) cobrança(s) em aberto continua(m) no financeiro.');
        }
      } else {
        toast('Contrato salvo com sucesso.');
      }
    } else {
      toast('Contrato salvo com sucesso.');
    }

    closeModal();
    loadContratos();
    loadCobrancas();
  });
}

// =====================================================================
// DOCUMENTOS ANEXADOS AO CONTRATO
// Arquivos como cópia do contrato assinado, documentação do proprietário
// e do inquilino, laudos de vistoria etc. — guardados no bucket privado
// "contrato-arquivos", acessível só por gerência/admin (mesma regra de
// quem pode editar o contrato em si).
// =====================================================================
const CONTRATO_ARQUIVOS_BUCKET = 'contrato-arquivos';
const CATEGORIA_ARQUIVO_LABEL = {
  contrato_assinado: 'Contrato assinado',
  documentacao_proprietario: 'Documentação do proprietário',
  documentacao_inquilino: 'Documentação do inquilino',
  vistoria: 'Vistoria',
  outro: 'Outro',
};

async function carregarArquivosContrato(contratoId) {
  const wrap = $('#contratoArquivosLista');
  if (!wrap) return;
  const { data, error } = await supabase
    .from('contrato_arquivos')
    .select('*, usuarios(nome)')
    .eq('contrato_id', contratoId)
    .order('criado_em', { ascending: false });

  if (error) { wrap.innerHTML = '<p class="dash-vazio">Erro ao carregar documentos.</p>'; console.error(error); return; }
  if (!data.length) { wrap.innerHTML = '<p class="dash-vazio">Nenhum documento anexado ainda.</p>'; return; }

  const porCategoria = {};
  data.forEach((a) => { (porCategoria[a.categoria] = porCategoria[a.categoria] || []).push(a); });

  wrap.innerHTML = Object.entries(porCategoria).map(([categoria, arquivos]) => `
    <div class="dash-bucket-titulo">${CATEGORIA_ARQUIVO_LABEL[categoria] || categoria}</div>
    ${arquivos.map((a) => `
      <div class="contrato-arquivo-item">
        <div class="contrato-arquivo-info">
          <span class="contrato-arquivo-nome">${escapeHtml(a.nome_arquivo)}</span>
          <span class="dash-linha-sub">${a.usuarios?.nome ? `enviado por ${escapeHtml(a.usuarios.nome)} · ` : ''}${dateTime(a.criado_em)}</span>
        </div>
        <div class="contrato-arquivo-acoes">
          <button type="button" class="btn btn-ghost btn-sm" data-action="contrato-arquivo-baixar" data-path="${escapeHtml(a.storage_path)}" data-nome="${escapeHtml(a.nome_arquivo)}">Baixar</button>
          <button type="button" class="tarefa-excluir" data-action="contrato-arquivo-excluir" data-id="${a.id}" data-path="${escapeHtml(a.storage_path)}" title="Excluir">✕</button>
        </div>
      </div>
    `).join('')}
  `).join('');
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#ca-upload-btn')) {
    const btn = e.target.closest('#ca-upload-btn');
    const contratoId = $('#c-id').value;
    const arquivoInput = $('#ca-arquivo');
    const categoria = $('#ca-categoria').value;
    const arquivo = arquivoInput.files[0];
    if (!arquivo) { toast('Selecione um arquivo primeiro.', true); return; }
    if (!contratoId) { toast('Salve o contrato antes de anexar documentos.', true); return; }

    btn.disabled = true;
    btn.textContent = 'Enviando...';
    const caminho = `${contratoId}/${categoria}/${Date.now()}-${arquivo.name}`;
    const { error: erroUpload } = await supabase.storage.from(CONTRATO_ARQUIVOS_BUCKET).upload(caminho, arquivo, { contentType: arquivo.type || 'application/octet-stream' });
    if (erroUpload) { toast('Erro ao enviar arquivo: ' + erroUpload.message, true); btn.disabled = false; btn.textContent = 'Enviar arquivo'; return; }

    const { error: erroInsert } = await supabase.from('contrato_arquivos').insert({
      contrato_id: contratoId,
      categoria,
      nome_arquivo: arquivo.name,
      storage_path: caminho,
      tamanho_bytes: arquivo.size,
      tipo_mime: arquivo.type || null,
      enviado_por: currentUsuario?.id || null,
    });
    if (erroInsert) { toast('Erro ao registrar arquivo: ' + erroInsert.message, true); btn.disabled = false; btn.textContent = 'Enviar arquivo'; return; }

    toast('Arquivo enviado.');
    arquivoInput.value = '';
    btn.disabled = false;
    btn.textContent = 'Enviar arquivo';
    carregarArquivosContrato(contratoId);
  }

  const btnBaixarArq = e.target.closest('[data-action="contrato-arquivo-baixar"]');
  if (btnBaixarArq) {
    const { data, error } = await supabase.storage.from(CONTRATO_ARQUIVOS_BUCKET).createSignedUrl(btnBaixarArq.dataset.path, 60);
    if (error || !data?.signedUrl) { toast('Não foi possível baixar este arquivo: ' + (error?.message || 'indisponível'), true); return; }
    const link = document.createElement('a');
    link.href = data.signedUrl;
    link.download = btnBaixarArq.dataset.nome;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  const btnExcluirArq = e.target.closest('[data-action="contrato-arquivo-excluir"]');
  if (btnExcluirArq) {
    if (!confirm('Excluir este documento? Essa ação não pode ser desfeita.')) return;
    const { error: erroStorage } = await supabase.storage.from(CONTRATO_ARQUIVOS_BUCKET).remove([btnExcluirArq.dataset.path]);
    if (erroStorage) { toast('Erro ao excluir arquivo: ' + erroStorage.message, true); return; }
    const { error: erroDelete } = await supabase.from('contrato_arquivos').delete().eq('id', btnExcluirArq.dataset.id);
    if (erroDelete) { toast('Erro ao excluir registro: ' + erroDelete.message, true); return; }
    toast('Documento excluído.');
    carregarArquivosContrato($('#c-id').value);
  }
});

// =====================================================================
// FINANCEIRO — COBRANÇAS (multa + juros por atraso)
// =====================================================================
function diasEmAtraso(dataVencimento, dataPagamento) {
  if (dataPagamento) return 0;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const venc = new Date(dataVencimento + 'T00:00:00');
  const diff = Math.floor((hoje - venc) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 0;
}

function valorAtualizado(valorBase, multaPct, jurosPct, diasAtraso, isento = false) {
  if (isento || diasAtraso <= 0) return valorBase;
  const multa = valorBase * (multaPct / 100);
  const juros = valorBase * (jurosPct / 100) * diasAtraso;
  return valorBase + multa + juros;
}

// Valor bruto total dos contratos de locação ativos (soma do "valor" do contrato, não da cobrança do mês)
async function loadLocacoesResumo() {
  const wrap = $('#locacoesResumo');
  if (!wrap) return;
  const { data, error } = await supabase
    .from('contratos')
    .select('valor')
    .eq('tipo', 'locacao')
    .eq('status', 'ativo');

  if (error) { console.error(error); return; }

  const total = (data || []).reduce((s, c) => s + Number(c.valor || 0), 0);
  wrap.innerHTML = `
    <div class="about-card about-card-total"><strong>${money(total)}</strong><span>Valor bruto — contratos de locação ativos (${data.length})</span></div>
  `;
}

let cobrancasCache = [];
const DIA_REPASSE_GRUPOS = [2, 12, 22, null]; // null = contrato ainda sem dia de repasse definido

// Soma os ajustes (descontos/acréscimos) de uma cobrança e devolve os impactos:
// no que o inquilino paga, no repasse do proprietário e no lucro da imobiliária.
// Regra "1º aluguel 100% imobiliária": verdadeiro quando o mês de referência da
// cobrança é o mesmo mês (ano+mês) do início do contrato. Usada para zerar o
// repasse ao proprietário no primeiro aluguel, quando o contrato tem essa
// configuração ativa (contrato.retem_primeiro_aluguel).
function ehMesDoPrimeiroAluguel(dataInicioIso, referenciaIso) {
  if (!dataInicioIso || !referenciaIso) return false;
  return dataInicioIso.slice(0, 7) === referenciaIso.slice(0, 7);
}

function calcularAjustes(ajustes) {
  let acrescimo = 0, descontoInquilino = 0, ajusteProprietario = 0, ajusteImobiliaria = 0;
  (ajustes || []).forEach((a) => {
    const valor = Number(a.valor) || 0;
    if (a.tipo === 'acrescimo') {
      acrescimo += valor;
      if (a.destino === 'proprietario') ajusteProprietario += valor;
      if (a.destino === 'imobiliaria') ajusteImobiliaria += valor;
    } else if (a.tipo === 'desconto') {
      if (a.destino === 'inquilino') descontoInquilino += valor;
      if (a.origem === 'proprietario') ajusteProprietario -= valor;
      if (a.origem === 'imobiliaria') ajusteImobiliaria -= valor;
      if (a.destino === 'proprietario') ajusteProprietario += valor;
      if (a.destino === 'imobiliaria') ajusteImobiliaria += valor;
    }
  });
  return { deltaInquilino: acrescimo - descontoInquilino, ajusteProprietario, ajusteImobiliaria };
}

async function loadCobrancas() {
  const wrap = $('#cobrancasGrupos');
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*, contratos(id, status, dia_repasse, multa_percentual, juros_diario_percentual, comissao_percentual, comissao_valor, comissao_valor_liquido, comissao_status, imoveis(titulo), pessoas!contratos_comprador_locatario_id_fkey(nome), usuarios(nome)), cobranca_ajustes(*)')
    .order('data_vencimento', { ascending: true });

  if (error) { wrap.innerHTML = `<p class="empty-state">Erro ao carregar cobranças.</p>`; console.error(error); return; }

  // referência mais antiga por contrato = "1º aluguel" (onde entra a comissão de fechamento do corretor)
  const primeiraRefPorContrato = {};
  (data || []).forEach((cb) => {
    const cid = cb.contratos?.id;
    if (!cid) return;
    if (!primeiraRefPorContrato[cid] || cb.referencia < primeiraRefPorContrato[cid]) primeiraRefPorContrato[cid] = cb.referencia;
  });

  cobrancasCache = (data || []).map((cb) => {
    const contrato = cb.contratos || {};
    const ajustes = cb.cobranca_ajustes || [];
    const ajustesCalc = calcularAjustes(ajustes);
    const valorBaseComAjuste = Math.round((Number(cb.valor_base) + ajustesCalc.deltaInquilino) * 100) / 100;
    const dias = diasEmAtraso(cb.data_vencimento, cb.data_pagamento);
    const atualizado = valorAtualizado(valorBaseComAjuste, contrato.multa_percentual ?? 2, contrato.juros_diario_percentual ?? 1, dias, cb.isento_multa_juros);
    const statusReal = cb.data_pagamento ? 'pago' : (dias > 0 ? 'atrasado' : 'pendente');
    const primeiroAluguel = contrato.id && primeiraRefPorContrato[contrato.id] === cb.referencia;
    return { ...cb, contrato, ajustes, ajustesCalc, valorBaseComAjuste, dias, atualizado, statusReal, diaRepasse: contrato.dia_repasse ?? null, primeiroAluguel };
  });

  renderCobrancasCards();
}

// Editor inline de comissão: valor líquido que entrou pra imobiliária + % do corretor
// sobre esse líquido = valor da comissão. Usado tanto no 1º aluguel (locação) quanto em vendas.
function comissaoEditorHtml(contrato, recarregar) {
  const status = contrato.comissao_status || 'pendente';
  return `
    <div class="comissao-editor-bloco">
      <div class="comissao-editor-linha">
        <label>Líquido recebido</label>
        <input type="number" step="0.01" min="0" class="comissao-liquido-input"
          data-contrato-id="${contrato.id}" value="${contrato.comissao_valor_liquido ?? ''}" placeholder="R$ 0,00">
        <label>%</label>
        <input type="number" step="0.5" min="0" max="100" class="comissao-pct-input"
          data-contrato-id="${contrato.id}" value="${contrato.comissao_percentual ?? ''}" placeholder="%">
        <span class="comissao-pct-valor" id="comissao-valor-${contrato.id}">${money(contrato.comissao_valor)}</span>
      </div>
      <div class="comissao-editor-linha">
        <button type="button" class="btn btn-sm comissao-status-toggle ${status === 'pago' ? 'btn-primary' : 'btn-ghost'}"
          data-action="toggle-comissao-status" data-contrato-id="${contrato.id}" data-status="${status}">
          ${status === 'pago' ? '✅ Paga' : '⏳ Pendente'}
        </button>
        <button class="btn btn-primary btn-sm" data-action="salvar-comissao" data-contrato-id="${contrato.id}" data-recarregar="${recarregar}">Salvar</button>
      </div>
    </div>
  `;
}

function renderCobrancasCards() {
  const wrap = $('#cobrancasGrupos');
  const termo = semAcento(($('#cobrancasSearch')?.value || '').trim());
  let filtradas = termo
    ? cobrancasCache.filter((cb) => semAcento([cb.contrato.imoveis?.titulo, cb.contrato.pessoas?.nome].filter(Boolean).join(' ')).includes(termo))
    // Contrato encerrado/cancelado não tem repasse futuro de verdade — some do quadro
    // principal do financeiro pra não confundir com o mês corrente. Continua achável
    // buscando pelo nome do imóvel/cliente (ex.: pra conferir uma pendência que ficou
    // aberta de propósito, quando o inquilino ainda deve).
    : cobrancasCache.filter((cb) => !['encerrado', 'cancelado'].includes(cb.contrato.status));

  if (filtroCobrancasAtraso) filtradas = filtradas.filter((cb) => cb.statusReal === 'atrasado');
  if (filtroFaixaVencimento) filtradas = filtradas.filter((cb) => String(cb.diaRepasse) === filtroFaixaVencimento && cb.statusReal !== 'pago');

  const bannerCobr = $('#cobrancasAlertaBanner');
  if (bannerCobr) {
    bannerCobr.hidden = !filtroCobrancasAtraso;
    if (filtroCobrancasAtraso) {
      bannerCobr.innerHTML = `<span>🔔 Mostrando <strong>${filtradas.length}</strong> recebimento${filtradas.length === 1 ? '' : 's'} em atraso.</span><button type="button" class="btn btn-ghost btn-sm" data-action="limpar-filtro-alerta" data-tela="cobrancas">Limpar filtro</button>`;
    }
  }

  if (!filtradas.length) { wrap.innerHTML = `<p class="empty-state">${filtroCobrancasAtraso ? 'Nenhum recebimento em atraso — tudo em dia! 🎉' : (cobrancasCache.length ? 'Nenhuma cobrança encontrada para essa busca.' : 'Nenhuma cobrança cadastrada ainda.')}</p>`; return; }

  const statusOrdem = { atrasado: 0, pendente: 1, pago: 2 };

  wrap.innerHTML = DIA_REPASSE_GRUPOS.map((dia) => {
    const doGrupo = filtradas
      .filter((cb) => cb.diaRepasse === dia)
      .sort((a, b) => {
        const sa = statusOrdem[a.statusReal] ?? 1;
        const sb = statusOrdem[b.statusReal] ?? 1;
        if (sa !== sb) return sa - sb;
        return new Date(a.data_vencimento) - new Date(b.data_vencimento);
      });
    if (!doGrupo.length) return '';

    const totalAberto = doGrupo.filter((cb) => !cb.data_pagamento).reduce((s, cb) => s + cb.atualizado, 0);
    const tituloGrupo = dia ? `Repasse dia ${String(dia).padStart(2, '0')}` : 'Sem dia de repasse definido';

    return `
      <div class="cobrancas-grupo">
        <div class="cobrancas-grupo-head">
          <h2>${tituloGrupo}</h2>
          <span class="imovel-card-meta">${doGrupo.length} cobrança${doGrupo.length > 1 ? 's' : ''} · em aberto: <strong>${money(totalAberto)}</strong></span>
        </div>
        <div class="imoveis-cards">
          ${doGrupo.map((cb) => `
            <article class="imovel-card${cb.primeiroAluguel ? ' imovel-card-destaque' : ''}">
              <div class="imovel-card-body" style="padding-left:2px;">
                <div class="imovel-card-top">
                  <div class="imovel-card-heading">
                    <span class="imovel-card-codigo">${new Date(cb.referencia + 'T00:00:00').toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })} · vence ${new Date(cb.data_vencimento + 'T00:00:00').toLocaleDateString('pt-BR')}</span>
                    <h3 class="imovel-card-titulo">${cb.contrato.imoveis?.titulo || 'Imóvel não vinculado'}</h3>
                    <p class="imovel-card-loc">${cb.contrato.pessoas?.nome || ''}${cb.dias > 0 ? ` · ${cb.dias} dia${cb.dias > 1 ? 's' : ''} em atraso` : ''}</p>
                  </div>
                  ${statusPill(cb.statusReal)}
                </div>
                ${cb.primeiroAluguel ? `
                <div class="imovel-card-badges">
                  <span class="badge-mini badge-mini-destaque">🏁 1º aluguel do contrato</span>
                  ${cb.contrato.usuarios?.nome ? `<span class="badge-mini">Corretor: ${cb.contrato.usuarios.nome}</span>` : ''}
                </div>
                ${comissaoEditorHtml(cb.contrato, 'locacoes')}
                ` : ''}
                ${cb.ajustes.length ? `
                <div class="ajustes-lista">
                  ${cb.ajustes.map((a) => `
                    <div class="ajuste-item ajuste-${a.tipo}">
                      <span class="ajuste-item-texto">
                        ${a.tipo === 'acrescimo' ? '➕' : '➖'} ${money(a.valor)} — ${a.descricao}${a.ajuste_recorrente_id ? ' <span class="badge-mini" title="Parcela de um desconto/crédito recorrente">🔁 recorrente</span>' : ''}
                        <span class="ajuste-meta">${a.tipo === 'desconto' ? `debitado de ${AJUSTE_LABEL[a.origem]}` : 'pago a mais pelo inquilino'}, creditado a ${AJUSTE_LABEL[a.destino]}</span>
                      </span>
                      ${souGerente ? `<button type="button" class="ajuste-excluir" data-action="ajuste-excluir" data-id="${a.id}" title="Excluir lançamento">✕</button>` : ''}
                    </div>
                  `).join('')}
                </div>
                ` : ''}
                <div class="imovel-card-footer">
                  <div class="imovel-card-precowrap">
                    <strong class="imovel-card-preco">${money(cb.atualizado)}</strong>
                    ${cb.atualizado !== cb.valor_base ? `<span class="imovel-card-meta">Base: ${money(cb.valor_base)}</span>` : ''}
                    ${!cb.isento_multa_juros && cb.dias > 0 ? '<span class="badge-mini" title="Esta cobrança está com a multa e os juros do atraso">⚠️ Com multa/juros do atraso</span>' : ''}
                  </div>
                  <div class="imovel-card-actions">
                    <button type="button" class="btn btn-ghost btn-sm" data-action="ajuste-abrir" data-cobranca-id="${cb.id}" data-referencia="${cb.referencia}">+ Ajuste</button>
                    ${!cb.data_pagamento && cb.dias > 0 && cb.isento_multa_juros ? `<button type="button" class="btn btn-ghost btn-sm" data-action="cobranca-reativar-multa" data-id="${cb.id}">Cobrar multa/juros</button>` : ''}
                    ${!cb.data_pagamento && !cb.isento_multa_juros ? `<button type="button" class="btn btn-ghost btn-sm" data-action="cobranca-isentar-multa" data-id="${cb.id}">Não cobrar multa/juros</button>` : ''}
                    ${!cb.data_pagamento ? `<button class="btn btn-ghost btn-sm" data-action="cobranca-pagar" data-id="${cb.id}">Marcar paga</button>` : ''}
                  </div>
                </div>
              </div>
            </article>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

$('#cobrancasSearch')?.addEventListener('input', renderCobrancasCards);

$('#gerarCobrancasBtn')?.addEventListener('click', async () => {
  const btn = $('#gerarCobrancasBtn');
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = 'Gerando...';
  const { data, error } = await supabase.rpc('gerar_cobrancas_do_mes');
  btn.disabled = false;
  btn.textContent = textoOriginal;
  if (error) { toast('Não foi possível gerar as cobranças.', true); console.error(error); return; }
  const criadas = Array.isArray(data) ? data[0]?.cobrancas_criadas : data;
  toast(criadas > 0 ? `${criadas} cobrança(s) do mês criada(s).` : 'Todos os contratos ativos já tinham cobrança este mês.');
  loadCobrancas();
});

async function loadRepasses() {
  const wrap = $('#repassesCards');
  if (!wrap) return;
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*, contratos!inner(tipo, status, taxa_administracao_percentual, dia_repasse, data_inicio, retem_primeiro_aluguel, imoveis(titulo), pessoas!contratos_vendedor_locador_id_fkey(nome)), cobranca_ajustes(*)')
    .eq('contratos.tipo', 'locacao')
    // Contrato encerrado/cancelado não gera mais repasse de verdade — mesmo motivo
    // do filtro em loadCobrancas (Gregório, 22/09/2026): parava aparecendo pra sempre.
    .not('contratos.status', 'in', '(encerrado,cancelado)')
    .order('data_vencimento', { ascending: false });

  if (error) { wrap.innerHTML = `<p class="empty-state">Erro ao carregar repasses.</p>`; console.error(error); return; }
  if (!data.length) { wrap.innerHTML = `<p class="empty-state">Nenhum repasse a calcular ainda.</p>`; return; }

  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

  let linhas = data.map((cb) => {
    const contrato = cb.contratos || {};
    const taxa = contrato.taxa_administracao_percentual ?? 10;
    const ajustes = cb.cobranca_ajustes || [];
    const { ajusteProprietario } = calcularAjustes(ajustes);
    // 1º aluguel 100% imobiliária: só zera o repasse se ainda não foi efetivado
    // (não reescreve repasses antigos já marcados como feitos).
    const primeiroAluguelRetido = (contrato.retem_primeiro_aluguel ?? true)
      && ehMesDoPrimeiroAluguel(contrato.data_inicio, cb.referencia)
      && !cb.repasse_efetivado_em;
    const repasseBase = primeiroAluguelRetido ? 0 : Math.round(cb.valor_base * (1 - taxa / 100) * 100) / 100;
    const repasse = Math.round((repasseBase + ajusteProprietario) * 100) / 100;

    // Atrasado = cobrança já paga pelo inquilino, o repasse ainda NÃO foi marcado como feito,
    // a data-limite do repasse (dia fixo do mês de referência) já passou, e há de fato
    // repasse a fazer (1º aluguel retido não gera pendência nenhuma).
    let atrasado = false;
    if (cb.data_pagamento && contrato.dia_repasse && !cb.repasse_efetivado_em && !primeiroAluguelRetido) {
      const [ano, mes] = cb.referencia.split('-').map(Number);
      const dataLimite = new Date(ano, mes - 1, contrato.dia_repasse);
      atrasado = dataLimite < hoje;
    }
    const statusRepasse = primeiroAluguelRetido ? 'retido_1_aluguel' : (cb.repasse_efetivado_em ? 'repassado' : (!cb.data_pagamento ? 'pendente' : (atrasado ? 'atrasado' : 'pago')));
    return { cb, contrato, taxa, ajustes, ajusteProprietario, repasse, primeiroAluguelRetido, statusRepasse };
  });

  if (filtroRepassesAtraso) linhas = linhas.filter((l) => l.statusRepasse === 'atrasado');
  if (filtroDiaRepasse) linhas = linhas.filter((l) => String(l.contrato.dia_repasse) === filtroDiaRepasse);

  const bannerRep = $('#repassesAlertaBanner');
  if (bannerRep) {
    bannerRep.hidden = !filtroRepassesAtraso;
    if (filtroRepassesAtraso) {
      bannerRep.innerHTML = `<span>🔔 Mostrando <strong>${linhas.length}</strong> repasse${linhas.length === 1 ? '' : 's'} atrasado${linhas.length === 1 ? '' : 's'}.</span><button type="button" class="btn btn-ghost btn-sm" data-action="limpar-filtro-alerta" data-tela="repasses">Limpar filtro</button>`;
    }
  }

  if (!linhas.length) { wrap.innerHTML = `<p class="empty-state">Nenhum repasse atrasado — tudo em dia! 🎉</p>`; return; }

  wrap.innerHTML = linhas.map(({ cb, contrato, taxa, ajustes, ajusteProprietario, repasse, statusRepasse }) => {
    const acaoRepasse = !cb.data_pagamento
      ? '<span class="imovel-card-meta">aguarda pagamento</span>'
      : (cb.repasse_efetivado_em
        ? `<button type="button" class="btn btn-ghost btn-sm" data-action="repasse-desfazer" data-id="${cb.id}">Desfazer</button>`
        : `<button type="button" class="btn btn-ghost btn-sm" data-action="repasse-marcar" data-id="${cb.id}">Marcar repassado</button>`);
    return `
      <article class="imovel-card">
        <div class="imovel-card-body" style="padding-left:2px;">
          <div class="imovel-card-top">
            <div class="imovel-card-heading">
              <span class="imovel-card-codigo">${new Date(cb.referencia + 'T00:00:00').toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}</span>
              <h3 class="imovel-card-titulo">${contrato.imoveis?.titulo || 'Imóvel não vinculado'}</h3>
              <p class="imovel-card-loc">${contrato.pessoas?.nome || 'Proprietário não vinculado'}</p>
            </div>
            ${statusPill(statusRepasse)}
          </div>
          ${ajustes.length ? `
          <div class="ajustes-lista">
            ${ajustes.map((a) => `
              <div class="ajuste-item ajuste-${a.tipo}">
                <span class="ajuste-item-texto">
                  ${a.tipo === 'acrescimo' ? '➕' : '➖'} ${money(a.valor)} — ${a.descricao}${a.ajuste_recorrente_id ? ' <span class="badge-mini" title="Parcela de um desconto/crédito recorrente">🔁 recorrente</span>' : ''}
                  <span class="ajuste-meta">${a.tipo === 'desconto' ? `debitado de ${AJUSTE_LABEL[a.origem]}` : 'pago a mais pelo inquilino'}, creditado a ${AJUSTE_LABEL[a.destino]}</span>
                </span>
                ${souGerente ? `<button type="button" class="ajuste-excluir" data-action="ajuste-excluir" data-id="${a.id}" title="Excluir lançamento">✕</button>` : ''}
              </div>
            `).join('')}
          </div>
          ` : ''}
          <div class="imovel-card-footer">
            <div class="imovel-card-precowrap">
              <strong class="imovel-card-preco">${money(repasse)}</strong>
              <span class="imovel-card-meta">Recebido: ${money(cb.valor_base)} · Taxa adm.: ${taxa}%${ajusteProprietario !== 0 ? ` · ${ajusteProprietario > 0 ? '+' : ''}${money(ajusteProprietario)} de ajuste` : ''}</span>
            </div>
            <div class="imovel-card-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-action="ajuste-abrir" data-cobranca-id="${cb.id}" data-referencia="${cb.referencia}">+ Ajuste</button>
              ${acaoRepasse}
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// =====================================================================
// FINANCEIRO — VENDAS (honorários e comissão do corretor)
// =====================================================================
let vendasCache = [];

$$('.faixa-vencimento-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.faixa-vencimento-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const faixa = btn.dataset.faixa || '';
    filtroFaixaVencimento = faixa === '02' ? '2' : faixa; // dia_repasse no banco é número (2), não "02"
    renderCobrancasCards();
  });
});

$$('.dia-repasse-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.dia-repasse-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filtroDiaRepasse = btn.dataset.diaRepasse || '';
    loadRepasses();
  });
});

$$('.financeiro-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.financeiro-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const alvo = btn.dataset.financeiroTab;
    $('#financeiro-locacoes').hidden = alvo !== 'locacoes';
    $('#financeiro-repasses').hidden = alvo !== 'repasses';
    $('#financeiro-vendas').hidden = alvo !== 'vendas';
    $('#financeiro-lucro').hidden = alvo !== 'lucro';
    $('#financeiro-relatorio-ir').hidden = alvo !== 'relatorio-ir';
    // "Nova cobrança" e "Gerar cobranças do mês" só fazem sentido pra locação — somem nas outras abas
    const btnNovaCobranca = $('#newCobrancaBtn');
    if (btnNovaCobranca) btnNovaCobranca.hidden = alvo !== 'locacoes';
    const btnGerarCobrancas = $('#gerarCobrancasBtn');
    if (btnGerarCobrancas) btnGerarCobrancas.hidden = alvo !== 'locacoes';
    const notaAuto = $('#financeiroAutoNota');
    if (notaAuto) notaAuto.hidden = alvo !== 'locacoes';
    if (alvo === 'lucro') loadLucro();
    if (alvo === 'relatorio-ir') carregarProprietariosParaIR();
  });
});

async function carregarProprietariosParaIR() {
  const select = $('#irProprietario');
  if (select.dataset.carregado) return;
  const { data } = await supabase
    .from('pessoas')
    .select('id, nome')
    .contains('papeis', ['proprietario'])
    .order('nome');
  (data || []).forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.nome;
    select.appendChild(opt);
  });
  select.dataset.carregado = '1';
}

$('#irGerarBtn')?.addEventListener('click', async () => {
  const proprietarioId = $('#irProprietario').value;
  const mesInicio = Number($('#irMesInicio').value);
  const mesFim = Number($('#irMesFim').value);
  const ano = Number($('#irAno').value);
  const resultado = $('#irRelatorioResultado');
  const btnImprimir = $('#irImprimirBtn');

  if (!proprietarioId) { toast('Selecione o proprietário.', true); return; }
  if (mesFim < mesInicio) { toast('O mês final não pode ser antes do mês inicial.', true); return; }

  const dataInicio = `${ano}-${String(mesInicio).padStart(2, '0')}-01`;
  const ultimoDiaMesFim = new Date(ano, mesFim, 0).getDate();
  const dataFim = `${ano}-${String(mesFim).padStart(2, '0')}-${ultimoDiaMesFim}`;

  const { data: proprietario } = await supabase.from('pessoas').select('nome, cpf_cnpj').eq('id', proprietarioId).maybeSingle();
  const { data: configSite } = await supabase.from('config_site').select('razao_social, cnpj').eq('id', 1).maybeSingle();

  const { data: contratos } = await supabase
    .from('contratos')
    .select('id, valor, taxa_administracao_percentual, imoveis(titulo, endereco)')
    .eq('vendedor_locador_id', proprietarioId)
    .eq('tipo', 'locacao');

  if (!contratos || !contratos.length) {
    resultado.innerHTML = '<p class="empty-state">Este proprietário não tem contratos de locação.</p>';
    btnImprimir.hidden = true;
    return;
  }

  let totalGeral = 0;
  const blocos = [];

  for (const contrato of contratos) {
    const { data: cobrancas } = await supabase
      .from('cobrancas')
      .select('referencia, valor_base, status, cobranca_ajustes(*)')
      .eq('contrato_id', contrato.id)
      .gte('referencia', dataInicio)
      .lte('referencia', dataFim)
      .order('referencia');

    if (!cobrancas || !cobrancas.length) continue;

    const taxa = Number(contrato.taxa_administracao_percentual || 0);
    let totalImovel = 0;
    const linhas = (cobrancas || []).map((cb) => {
      const bruto = Number(cb.valor_base || 0);
      let ajusteProprietario = 0;
      (cb.cobranca_ajustes || []).forEach((a) => {
        const v = Number(a.valor) || 0;
        if (a.tipo === 'acrescimo' && a.destino === 'proprietario') ajusteProprietario += v;
        if (a.tipo === 'desconto' && a.destino === 'proprietario') ajusteProprietario += v;
        if (a.tipo === 'desconto' && a.origem === 'proprietario') ajusteProprietario -= v;
      });
      const liquido = bruto * (1 - taxa / 100) + ajusteProprietario;
      totalImovel += liquido;
      totalGeral += liquido;
      const [ay, am] = cb.referencia.split('-');
      const nomesMesesAbrev = ['', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      return `<tr><td>${nomesMesesAbrev[Number(am)]}/${ay}</td><td>${money(liquido)}</td><td>${cb.status}</td></tr>`;
    }).join('');

    blocos.push(`
      <div class="panel" style="margin-top:16px;">
        <h3 style="margin:0 0 8px;">${contrato.imoveis?.titulo || 'Imóvel'} — ${contrato.imoveis?.endereco || ''}</h3>
        <table class="tabela-simples">
          <thead><tr><th>Mês</th><th>Valor repassado</th><th>Status</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
        <p style="text-align:right;font-weight:700;margin-top:8px;">Subtotal do imóvel: ${money(totalImovel)}</p>
      </div>
    `);
  }

  const nomesMeses = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  resultado.innerHTML = `
    <div id="irRelatorioImprimivel" class="panel" style="margin-top:20px;">
      <div style="text-align:center;margin-bottom:20px;">
        <h2 style="margin:0;">${configSite?.razao_social || 'Gregório | Meu Lar Imóveis'}</h2>
        <p style="margin:2px 0;">CNPJ: ${configSite?.cnpj || '—'}</p>
        <h3 style="margin:16px 0 0;">Relatório de repasses para fins de Imposto de Renda</h3>
        <p>Proprietário: <strong>${proprietario?.nome || ''}</strong>${proprietario?.cpf_cnpj ? ' — CPF/CNPJ: ' + proprietario.cpf_cnpj : ''}</p>
        <p>Período: ${nomesMeses[mesInicio]} a ${nomesMeses[mesFim]} de ${ano}</p>
      </div>
      ${blocos.join('')}
      <h2 style="text-align:right;margin-top:24px;border-top:2px solid var(--navy-900);padding-top:12px;">Total repassado no período: ${money(totalGeral)}</h2>
      <p style="font-size:.75rem;color:var(--gray-text);margin-top:16px;">Este relatório reflete os valores efetivamente repassados pela administradora ao proprietário no período selecionado, já descontada a taxa de administração e ajustados eventuais créditos/débitos lançados. Não substitui orientação de um contador.</p>
    </div>
  `;
  btnImprimir.hidden = false;
});

$('#irImprimirBtn')?.addEventListener('click', () => {
  const conteudo = $('#irRelatorioImprimivel').outerHTML;
  const janela = window.open('', '_blank');
  janela.document.write(`<html><head><title>Relatório IR</title><link rel="stylesheet" href="css/style.css"></head><body style="padding:24px;">${conteudo}</body></html>`);
  janela.document.close();
  janela.focus();
  setTimeout(() => janela.print(), 300);
});

async function loadVendas() {
  const wrap = $('#vendasCards');
  if (!wrap) return;
  const { data, error } = await supabase
    .from('contratos')
    .select('*, imoveis(titulo, bairro, cidade), pessoas!contratos_comprador_locatario_id_fkey(nome), usuarios(nome)')
    .eq('tipo', 'venda')
    .order('data_inicio', { ascending: false });

  if (error) { wrap.innerHTML = `<p class="empty-state">Erro ao carregar vendas.</p>`; console.error(error); return; }

  vendasCache = (data || []).slice().sort((a, b) => {
    const pa = CONTRATO_STATUS_PRIORIDADE[a.status] ?? 1.5;
    const pb = CONTRATO_STATUS_PRIORIDADE[b.status] ?? 1.5;
    if (pa !== pb) return pa - pb;
    return new Date(b.data_inicio || b.criado_em) - new Date(a.data_inicio || a.criado_em);
  });

  renderVendasCards();
}

function renderVendasCards() {
  const wrap = $('#vendasCards');
  const resumo = $('#vendasResumo');
  const termo = semAcento(($('#vendasSearch')?.value || '').trim());
  const filtradas = termo
    ? vendasCache.filter((v) => semAcento([v.imoveis?.titulo, v.pessoas?.nome, v.usuarios?.nome].filter(Boolean).join(' ')).includes(termo))
    : vendasCache;

  const fechadas = vendasCache.filter((v) => v.status === 'ativo' || v.status === 'encerrado');
  const totalVendas = fechadas.reduce((s, v) => s + Number(v.valor || 0), 0);
  const comissaoPendente = fechadas.filter((v) => (v.comissao_status || 'pendente') !== 'pago').reduce((s, v) => s + Number(v.comissao_valor || 0), 0);
  const comissaoPaga = fechadas.filter((v) => v.comissao_status === 'pago').reduce((s, v) => s + Number(v.comissao_valor || 0), 0);
  if (resumo) {
    resumo.innerHTML = `
      <div class="about-card"><strong>${fechadas.length}</strong><span>Vendas fechadas</span></div>
      <div class="about-card"><strong>${money(totalVendas)}</strong><span>Volume vendido</span></div>
      <div class="about-card"><strong>${money(comissaoPendente)}</strong><span>Comissão pendente de pagar</span></div>
      <div class="about-card"><strong>${money(comissaoPaga)}</strong><span>Comissão já paga</span></div>
    `;
  }

  if (!filtradas.length) { wrap.innerHTML = `<p class="empty-state">${vendasCache.length ? 'Nenhuma venda encontrada para essa busca.' : 'Nenhuma venda cadastrada ainda.'}</p>`; return; }

  wrap.innerHTML = filtradas.map((v) => {
    const localizacao = [v.imoveis?.bairro, v.imoveis?.cidade].filter(Boolean).join(' — ');
    const data = v.data_inicio ? new Date(v.data_inicio + 'T00:00:00').toLocaleDateString('pt-BR') : '—';
    return `
      <article class="imovel-card">
        <div class="imovel-card-body" style="padding-left:2px;">
          <div class="imovel-card-top">
            <div class="imovel-card-heading">
              <span class="imovel-card-codigo">Venda em ${data}</span>
              <h3 class="imovel-card-titulo">${v.imoveis?.titulo || 'Imóvel não vinculado'}</h3>
              <p class="imovel-card-loc">${localizacao ? localizacao + ' · ' : ''}Comprador: ${v.pessoas?.nome || '—'}</p>
            </div>
            ${statusPill(v.status)}
          </div>
          <div class="imovel-card-badges">
            <span class="badge-mini">Corretor: ${v.usuarios?.nome || '—'}</span>
          </div>
          ${comissaoEditorHtml(v, 'vendas')}
          <div class="imovel-card-footer">
            <div class="imovel-card-precowrap">
              <strong class="imovel-card-preco">${money(v.valor)}</strong>
            </div>
            <div class="imovel-card-actions">
              <button class="btn btn-ghost btn-sm" data-action="contrato-edit" data-id="${v.id}">Editar</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

$('#vendasSearch')?.addEventListener('input', renderVendasCards);

// =====================================================================
// FINANCEIRO — LUCRO DO MÊS (visão da imobiliária, separada do repasse/comissão do corretor)
// =====================================================================
function lucroItemCard({ titulo, sub, valorBase, valorLucro, badge, semDados }) {
  return `
    <article class="imovel-card">
      <div class="imovel-card-body" style="padding-left:2px;">
        <div class="imovel-card-top">
          <div class="imovel-card-heading">
            ${badge ? `<span class="imovel-card-codigo">${badge}</span>` : ''}
            <h3 class="imovel-card-titulo">${titulo}</h3>
            <p class="imovel-card-loc">${sub || ''}</p>
          </div>
        </div>
        <div class="imovel-card-footer">
          <div class="imovel-card-precowrap">
            <strong class="imovel-card-preco">${money(valorLucro)}</strong>
            ${valorBase !== undefined ? `<span class="imovel-card-meta">Base: ${money(valorBase)}</span>` : ''}
          </div>
          ${semDados ? '<span class="badge-mini badge-mini-destaque">Falta lançar líquido/% do corretor</span>' : ''}
        </div>
      </div>
    </article>
  `;
}

$('#lucroMes')?.addEventListener('change', loadLucro);

async function loadLucro() {
  const mesInput = $('#lucroMes');
  if (!mesInput) return;
  if (!mesInput.value) {
    const agora = new Date();
    mesInput.value = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
  }
  const mes = mesInput.value;
  const [ano, mesNum] = mes.split('-').map(Number);
  const inicioMes = `${mes}-01`;
  const fimMes = new Date(ano, mesNum, 0).toISOString().slice(0, 10);

  const resumo = $('#lucroResumo');
  const wrapTaxa = $('#lucroTaxaAdmCards');
  const wrapAluguel = $('#lucroPrimeiroAluguelCards');
  const wrapVendas = $('#lucroVendasCards');

  const [{ data: cobrancasPagas, error: err1 }, { data: todasCobrancas, error: err2 }, { data: vendasDoMes, error: err3 }, { data: ajustesDoMes, error: err4 }] = await Promise.all([
    supabase.from('cobrancas')
      .select('*, contratos!inner(tipo, taxa_administracao_percentual, imoveis(titulo), pessoas!contratos_comprador_locatario_id_fkey(nome))')
      .eq('contratos.tipo', 'locacao')
      .not('data_pagamento', 'is', null)
      .gte('data_pagamento', inicioMes)
      .lte('data_pagamento', fimMes),
    supabase.from('cobrancas')
      .select('id, contrato_id, referencia, valor_base, contratos!inner(tipo, comissao_valor_liquido, comissao_valor, comissao_status, imoveis(titulo), pessoas!contratos_comprador_locatario_id_fkey(nome), usuarios(nome))')
      .eq('contratos.tipo', 'locacao')
      .order('referencia', { ascending: true }),
    supabase.from('contratos')
      .select('*, imoveis(titulo), pessoas!contratos_comprador_locatario_id_fkey(nome), usuarios(nome)')
      .eq('tipo', 'venda')
      .gte('data_inicio', inicioMes)
      .lte('data_inicio', fimMes),
    supabase.from('cobranca_ajustes')
      .select('*, cobrancas!inner(referencia, contratos!inner(tipo))')
      .eq('cobrancas.contratos.tipo', 'locacao')
      .gte('cobrancas.referencia', inicioMes)
      .lte('cobrancas.referencia', fimMes),
  ]);

  if (err1 || err2 || err3 || err4) {
    if (wrapTaxa) wrapTaxa.innerHTML = `<p class="empty-state">Erro ao carregar o lucro do mês.</p>`;
    console.error(err1 || err2 || err3 || err4);
    return;
  }

  // taxa de administração = corte da imobiliária sobre cada aluguel pago no mês
  const taxaItens = (cobrancasPagas || []).map((cb) => {
    const contrato = cb.contratos || {};
    const taxa = contrato.taxa_administracao_percentual ?? 10;
    const valor = Math.round(cb.valor_base * (taxa / 100) * 100) / 100;
    return { cb, contrato, taxa, valor };
  });
  const totalTaxaAdm = taxaItens.reduce((s, i) => s + i.valor, 0);

  // 1º aluguel de cada contrato de locação, filtrando os que caem dentro do mês selecionado
  const primeiraRef = {};
  (todasCobrancas || []).forEach((cb) => {
    if (!primeiraRef[cb.contrato_id]) primeiraRef[cb.contrato_id] = cb.referencia;
  });
  const primeirosDoMes = (todasCobrancas || []).filter((cb) =>
    primeiraRef[cb.contrato_id] === cb.referencia && cb.referencia >= inicioMes && cb.referencia <= fimMes
  );
  const totalLucroAluguel = primeirosDoMes.reduce((s, cb) => {
    const c = cb.contratos || {};
    return s + (Number(c.comissao_valor_liquido || 0) - Number(c.comissao_valor || 0));
  }, 0);

  const totalLucroVendas = (vendasDoMes || []).reduce((s, v) =>
    s + (Number(v.comissao_valor_liquido || 0) - Number(v.comissao_valor || 0)), 0);

  // descontos/acréscimos lançados no mês que afetam o resultado da imobiliária (não do proprietário)
  const { ajusteImobiliaria: totalAjustesImobiliaria } = calcularAjustes(ajustesDoMes);

  const totalGeral = totalTaxaAdm + totalLucroAluguel + totalLucroVendas + totalAjustesImobiliaria;

  if (resumo) {
    resumo.innerHTML = `
      <div class="about-card"><strong>${money(totalTaxaAdm)}</strong><span>Taxa de administração (locações)</span></div>
      <div class="about-card"><strong>${money(totalLucroAluguel)}</strong><span>1º aluguel, já líquido de comissão</span></div>
      <div class="about-card"><strong>${money(totalLucroVendas)}</strong><span>Vendas, já líquido de comissão</span></div>
      <div class="about-card"><strong>${totalAjustesImobiliaria >= 0 ? '+' : ''}${money(totalAjustesImobiliaria)}</strong><span>Ajustes do mês (descontos/acréscimos)</span></div>
      <div class="about-card about-card-total"><strong>${money(totalGeral)}</strong><span>Lucro total do mês</span></div>
    `;
  }

  if (wrapTaxa) {
    wrapTaxa.innerHTML = taxaItens.length
      ? taxaItens.map((i) => lucroItemCard({
          titulo: i.contrato.imoveis?.titulo || 'Imóvel não vinculado',
          sub: `${i.contrato.pessoas?.nome || ''} · taxa ${i.taxa}%`,
          badge: new Date(i.cb.referencia + 'T00:00:00').toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }),
          valorBase: i.cb.valor_base,
          valorLucro: i.valor,
        })).join('')
      : `<p class="empty-state">Nenhum aluguel pago dentro desse mês ainda.</p>`;
  }

  if (wrapAluguel) {
    wrapAluguel.innerHTML = primeirosDoMes.length
      ? primeirosDoMes.map((cb) => {
          const c = cb.contratos || {};
          const semDados = c.comissao_valor_liquido == null || c.comissao_percentual === null;
          return lucroItemCard({
            titulo: c.imoveis?.titulo || 'Imóvel não vinculado',
            sub: `${c.pessoas?.nome || ''}${c.usuarios?.nome ? ` · Corretor: ${c.usuarios.nome}` : ''}`,
            valorBase: c.comissao_valor_liquido,
            valorLucro: Number(c.comissao_valor_liquido || 0) - Number(c.comissao_valor || 0),
            semDados,
          });
        }).join('')
      : `<p class="empty-state">Nenhum contrato de locação novo nesse mês.</p>`;
  }

  if (wrapVendas) {
    wrapVendas.innerHTML = (vendasDoMes || []).length
      ? vendasDoMes.map((v) => {
          const semDados = v.comissao_valor_liquido == null || v.comissao_percentual === null;
          return lucroItemCard({
            titulo: v.imoveis?.titulo || 'Imóvel não vinculado',
            sub: `${v.pessoas?.nome || ''}${v.usuarios?.nome ? ` · Corretor: ${v.usuarios.nome}` : ''}`,
            valorBase: v.comissao_valor_liquido,
            valorLucro: Number(v.comissao_valor_liquido || 0) - Number(v.comissao_valor || 0),
            semDados,
          });
        }).join('')
      : `<p class="empty-state">Nenhuma venda fechada nesse mês.</p>`;
  }
}

// =====================================================================
// AJUSTES DA COBRANÇA — desconto / acréscimo, com quem debita e quem credita
// =====================================================================
const AJUSTE_LABEL = {
  inquilino: 'Inquilino', proprietario: 'Proprietário', imobiliaria: 'Imobiliária',
};

function ajusteDestinoOpcoes(tipo, origem) {
  if (tipo === 'acrescimo') return ['proprietario', 'imobiliaria'];
  if (origem === 'proprietario') return ['inquilino', 'imobiliaria'];
  if (origem === 'imobiliaria') return ['inquilino', 'proprietario'];
  return [];
}

function ajusteForm(cobrancaId, referencia) {
  return `
    <h2>Desconto / acréscimo na cobrança</h2>
    <form class="modal-form" id="ajusteForm">
      <input type="hidden" id="aj-cobranca-id" value="${cobrancaId}">
      <div class="form-row"><label>Tipo</label>
        <select id="aj-tipo">
          <option value="desconto">Desconto</option>
          <option value="acrescimo">Acréscimo (inquilino paga mais)</option>
        </select>
      </div>
      <div class="form-row" id="aj-origem-wrap"><label>Descontar de</label>
        <select id="aj-origem">
          <option value="proprietario">Proprietário</option>
          <option value="imobiliaria">Imobiliária</option>
        </select>
      </div>
      <div class="form-row full"><label id="aj-destino-label">Creditar para</label>
        <select id="aj-destino"></select>
      </div>
      <div class="form-row"><label>Valor (R$)</label><input required type="number" step="0.01" min="0.01" id="aj-valor"></div>
      <div class="form-row full"><label>Descrição (do que se trata)</label><textarea required id="aj-descricao" rows="2" placeholder="Ex: desconto combinado por atraso na manutenção, taxa extra de limpeza, etc."></textarea></div>
      <div class="form-row"><label>Data de início (mês da 1ª parcela)</label>
        <input type="month" id="aj-data-inicio" value="${(referencia || '').slice(0, 7)}">
      </div>
      <div class="form-row"><label>Repetir por quantas parcelas (cobranças)?</label>
        <input type="number" id="aj-parcelas" min="1" value="1">
      </div>
      <div class="form-row full">
        <p style="font-size:.75rem;color:var(--gray-text);margin:0;">1 parcela = só no mês de início escolhido. Acima de 1, o mesmo valor é lançado automaticamente mês a mês a partir dali, até completar a quantidade escolhida — mesmo nas cobranças que ainda não foram geradas. Se escolher um mês de início posterior ao de hoje, nada é lançado agora: o sistema espera esse mês chegar.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelAjuste">Cancelar</button>
        <button type="submit" class="btn btn-primary">Lançar</button>
      </div>
    </form>
  `;
}

function ajusteAtualizarDestino() {
  const tipo = $('#aj-tipo').value;
  const origem = $('#aj-origem').value;
  $('#aj-origem-wrap').hidden = tipo !== 'desconto';
  const opcoes = ajusteDestinoOpcoes(tipo, tipo === 'desconto' ? origem : null);
  $('#aj-destino').innerHTML = opcoes.map((o) => `<option value="${o}">${AJUSTE_LABEL[o]}</option>`).join('');
  $('#aj-destino-label').textContent = tipo === 'acrescimo' ? 'Creditar para' : 'Creditar para (quem ganha o desconto)';
}

document.addEventListener('click', (e) => {
  if (e.target.dataset.action !== 'ajuste-abrir') return;
  openModal(ajusteForm(e.target.dataset.cobrancaId, e.target.dataset.referencia));
  ajusteAtualizarDestino();
  $('#aj-tipo').addEventListener('change', ajusteAtualizarDestino);
  $('#aj-origem').addEventListener('change', ajusteAtualizarDestino);
  $('#cancelAjuste').addEventListener('click', closeModal);

  $('#ajusteForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btnSubmit = ev.target.querySelector('button[type="submit"]');
    btnSubmit.disabled = true; btnSubmit.textContent = 'Lançando...';

    const cobrancaId = $('#aj-cobranca-id').value;
    const tipo = $('#aj-tipo').value;
    const parcelas = Math.max(1, Number($('#aj-parcelas').value) || 1);
    const mesInicio = $('#aj-data-inicio').value; // "AAAA-MM"
    const referenciaInicio = mesInicio ? `${mesInicio}-01` : null;
    const base = {
      tipo,
      origem: tipo === 'desconto' ? $('#aj-origem').value : null,
      destino: $('#aj-destino').value,
      valor: Number($('#aj-valor').value),
      descricao: $('#aj-descricao').value.trim(),
      criado_por: currentUsuario?.id || null,
    };

    const cobrancaAtual = cobrancasCache.find((cb) => cb.id === cobrancaId);
    const contratoId = cobrancaAtual?.contrato?.id;

    if (!referenciaInicio || !contratoId) {
      toast('Não foi possível identificar o contrato/mês de início.', true);
      btnSubmit.disabled = false; btnSubmit.textContent = 'Lançar';
      return;
    }

    // Busca, a partir do mês de início escolhido, quantas cobranças desse contrato JÁ existem
    // (podem ser 0, se o início for num mês futuro ainda não gerado).
    const { data: alvos, error: erroBusca } = await supabase
      .from('cobrancas')
      .select('id, referencia')
      .eq('contrato_id', contratoId)
      .gte('referencia', referenciaInicio)
      .order('referencia', { ascending: true })
      .limit(parcelas);

    if (erroBusca) {
      toast('Erro ao buscar cobranças: ' + erroBusca.message, true);
      btnSubmit.disabled = false; btnSubmit.textContent = 'Lançar';
      return;
    }

    let lancadasAgora = 0;
    for (const cb of alvos || []) {
      const { error: erroLanc } = await supabase.from('cobranca_ajustes').insert({ ...base, cobranca_id: cb.id });
      if (!erroLanc) lancadasAgora += 1;
    }

    const restantes = parcelas - lancadasAgora;

    if (restantes > 0) {
      const { error: erroRegra } = await supabase.from('ajustes_recorrentes').insert({
        contrato_id: contratoId,
        tipo: base.tipo,
        origem: base.origem,
        destino: base.destino,
        valor: base.valor,
        descricao: base.descricao,
        parcelas_total: parcelas,
        parcelas_lancadas: lancadasAgora,
        referencia_inicio: referenciaInicio,
        ativo: true,
        criado_por: currentUsuario?.id || null,
      });
      if (erroRegra) console.error(erroRegra);
      const mesLegivel = new Date(referenciaInicio + 'T00:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      toast(lancadasAgora > 0
        ? `Lançado em ${lancadasAgora} de ${parcelas} parcela(s). As ${restantes} restantes serão lançadas automaticamente a partir de ${mesLegivel}, conforme as cobranças forem geradas.`
        : `Nenhuma cobrança existe ainda a partir de ${mesLegivel}. As ${parcelas} parcela(s) serão lançadas automaticamente assim que esse mês chegar.`);
    } else {
      toast(`Lançado em ${lancadasAgora} parcela(s) com sucesso.`);
    }

    closeModal();
    loadCobrancas();
    loadRepasses();
  });
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action !== 'ajuste-excluir') return;
  if (!confirm('Excluir este lançamento?')) return;
  const { error } = await supabase.from('cobranca_ajustes').delete().eq('id', e.target.dataset.id);
  if (error) { toast('Não foi possível excluir.', true); return; }
  toast('Lançamento excluído.');
  loadCobrancas();
  loadRepasses();
});

async function cobrancaForm() {
  const { data: contratos } = await supabase
    .from('contratos')
    .select('id, imoveis(titulo), pessoas!contratos_comprador_locatario_id_fkey(nome), valor')
    .eq('tipo', 'locacao')
    .eq('status', 'ativo');

  return `
    <h2>Nova cobrança</h2>
    <form class="modal-form" id="cobrancaForm">
      <div class="form-row full"><label>Contrato de locação</label>
        <select id="cb-contrato" required>
          <option value="">Selecione...</option>
          ${(contratos || []).map((c) => `<option value="${c.id}" data-valor="${c.valor}">${c.imoveis?.titulo || 'Imóvel'} — ${c.pessoas?.nome || ''}</option>`).join('')}
        </select>
        ${!contratos?.length ? '<p style="font-size:.78rem;margin-top:6px;">Nenhum contrato de locação ativo encontrado.</p>' : ''}
      </div>
      <div class="form-row"><label>Mês de referência</label><input required type="month" id="cb-referencia"></div>
      <div class="form-row"><label>Vencimento</label><input required type="date" id="cb-vencimento"></div>
      <div class="form-row full"><label>Valor do aluguel (R$)</label><input required type="number" id="cb-valor"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelCobranca">Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar cobrança</button>
      </div>
    </form>
  `;
}

$('#newCobrancaBtn').addEventListener('click', async () => {
  openModal(await cobrancaForm());
  $('#cancelCobranca').addEventListener('click', closeModal);

  $('#cb-contrato').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt?.dataset.valor) $('#cb-valor').value = opt.dataset.valor;
  });

  $('#cobrancaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      contrato_id: $('#cb-contrato').value,
      referencia: $('#cb-referencia').value + '-01',
      data_vencimento: $('#cb-vencimento').value,
      valor_base: Number($('#cb-valor').value),
      status: 'pendente',
    };
    const { error } = await supabase.from('cobrancas').insert(payload);
    if (error) { toast('Erro ao criar cobrança: ' + error.message, true); console.error(error); return; }
    toast('Cobrança criada.');
    closeModal();
    loadCobrancas();
  });
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'cobranca-pagar') {
    if (!confirm('Confirmar recebimento deste pagamento hoje?')) return;
    const hoje = new Date().toISOString().slice(0, 10);
    const { error } = await supabase.from('cobrancas').update({ data_pagamento: hoje, status: 'pago' }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível confirmar.', true); return; }
    toast('Pagamento confirmado.');
    loadCobrancas();
  }

  if (e.target.dataset.action === 'cobranca-isentar-multa') {
    if (!confirm('Não cobrar a multa e os juros do atraso nesta cobrança? O inquilino paga só o valor base.')) return;
    const { error } = await supabase.from('cobrancas').update({ isento_multa_juros: true }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar a cobrança.', true); return; }
    toast('Multa e juros do atraso retirados desta cobrança.');
    loadCobrancas();
  }

  if (e.target.dataset.action === 'cobranca-reativar-multa') {
    if (!confirm('Cobrar a multa e os juros pelo atraso nesta cobrança? O valor passa a incluir a multa e os juros diários definidos no contrato.')) return;
    const { error } = await supabase.from('cobrancas').update({ isento_multa_juros: false }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar a cobrança.', true); return; }
    toast('Multa e juros do atraso aplicados a esta cobrança.');
    loadCobrancas();
  }

  if (e.target.dataset.action === 'repasse-marcar') {
    if (!confirm('Confirmar que o repasse deste aluguel já foi feito ao proprietário? Ele sai da lista de repasses em atraso.')) return;
    const { error } = await supabase.from('cobrancas').update({ repasse_efetivado_em: new Date().toISOString().slice(0, 10) }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível marcar o repasse.', true); return; }
    toast('Repasse marcado como feito.');
    loadRepasses();
    if ($('#painelExecutivoLocacao') && !$('#painelExecutivoLocacao').hidden) carregarPainelExecutivoLocacao();
  }

  if (e.target.dataset.action === 'repasse-desfazer') {
    const { error } = await supabase.from('cobrancas').update({ repasse_efetivado_em: null }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível desfazer.', true); return; }
    toast('Repasse voltou para pendente.');
    loadRepasses();
    if ($('#painelExecutivoLocacao') && !$('#painelExecutivoLocacao').hidden) carregarPainelExecutivoLocacao();
  }

  if (e.target.dataset.action === 'salvar-comissao') {
    const contratoId = e.target.dataset.contratoId;
    const liquidoInput = document.querySelector(`.comissao-liquido-input[data-contrato-id="${contratoId}"]`);
    const pctInput = document.querySelector(`.comissao-pct-input[data-contrato-id="${contratoId}"]`);
    const toggleBtn = document.querySelector(`.comissao-status-toggle[data-contrato-id="${contratoId}"]`);
    if (!liquidoInput || !pctInput) return;

    const liquido = liquidoInput.value === '' ? null : Number(liquidoInput.value);
    const pct = pctInput.value === '' ? null : Number(pctInput.value);
    const valor = (liquido !== null && pct !== null) ? Math.round(liquido * (pct / 100) * 100) / 100 : null;
    const status = toggleBtn?.dataset.status || 'pendente';

    e.target.disabled = true;
    const { error } = await supabase.from('contratos')
      .update({ comissao_valor_liquido: liquido, comissao_percentual: pct, comissao_valor: valor, comissao_status: status })
      .eq('id', contratoId);
    e.target.disabled = false;

    if (error) { toast('Não foi possível salvar a comissão.', true); console.error(error); return; }
    toast('Comissão salva.');
    if (e.target.dataset.recarregar === 'vendas') loadVendas();
    else loadCobrancas();
  }

  if (e.target.dataset.action === 'toggle-comissao-status') {
    const contratoId = e.target.dataset.contratoId;
    const novoStatus = e.target.dataset.status === 'pago' ? 'pendente' : 'pago';
    e.target.disabled = true;
    const { error } = await supabase.from('contratos').update({ comissao_status: novoStatus }).eq('id', contratoId);
    e.target.disabled = false;
    if (error) { toast('Não foi possível atualizar o status da comissão.', true); return; }
    e.target.dataset.status = novoStatus;
    e.target.textContent = novoStatus === 'pago' ? '✅ Paga' : '⏳ Pendente';
    e.target.classList.toggle('btn-primary', novoStatus === 'pago');
    e.target.classList.toggle('btn-ghost', novoStatus !== 'pago');
    toast(novoStatus === 'pago' ? 'Comissão marcada como paga.' : 'Comissão marcada como pendente.');
  }
});

// Recalcula o valor em R$ da comissão em tempo real (líquido recebido × % do corretor)
document.addEventListener('input', (e) => {
  if (!e.target.classList?.contains('comissao-liquido-input') && !e.target.classList?.contains('comissao-pct-input')) return;
  const contratoId = e.target.dataset.contratoId;
  const liquidoInput = document.querySelector(`.comissao-liquido-input[data-contrato-id="${contratoId}"]`);
  const pctInput = document.querySelector(`.comissao-pct-input[data-contrato-id="${contratoId}"]`);
  const liquido = Number(liquidoInput?.value || 0);
  const pct = Number(pctInput?.value || 0);
  const alvo = document.getElementById(`comissao-valor-${contratoId}`);
  if (alvo) alvo.textContent = money(Math.round(liquido * (pct / 100) * 100) / 100);
});

// =====================================================================
// UPLOAD DE IMAGENS (Storage)
// =====================================================================
async function uploadImagem(file, pasta) {
  const nomeArquivo = `${pasta}/${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
  const { error } = await supabase.storage.from('site-imagens').upload(nomeArquivo, file, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('site-imagens').getPublicUrl(nomeArquivo);
  return data.publicUrl;
}

// =====================================================================
// MARCA D'ÁGUA NAS FOTOS DE IMÓVEIS (aplicada no navegador, via canvas)
// =====================================================================
let _logoMarcaDaguaPromise = null;
function carregarLogoMarcaDagua() {
  if (!_logoMarcaDaguaPromise) {
    _logoMarcaDaguaPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = 'assets/logo-icon.png';
    });
  }
  return _logoMarcaDaguaPromise;
}

function carregarImagemDeArquivo(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

async function aplicarMarcaDagua(file, opcoes = {}) {
  const posicao = opcoes.posicao || 'centro';
  const transparencia = Math.min(80, Math.max(20, Number(opcoes.transparencia) || 50));
  const alpha = 1 - (transparencia / 100); // 20% transparência = quase opaca (0.8) · 80% transparência = bem sutil (0.2)

  const [imgOriginal, logo] = await Promise.all([carregarImagemDeArquivo(file), carregarLogoMarcaDagua().catch(() => null)]);

  const MAX_LADO = 1600;
  let largura = imgOriginal.naturalWidth || imgOriginal.width;
  let altura = imgOriginal.naturalHeight || imgOriginal.height;
  if (largura > MAX_LADO || altura > MAX_LADO) {
    const escala = MAX_LADO / Math.max(largura, altura);
    largura = Math.round(largura * escala);
    altura = Math.round(altura * escala);
  }

  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgOriginal, 0, 0, largura, altura);

  if (logo) {
    const ehCentro = posicao === 'centro';
    const logoLargura = Math.round(largura * (ehCentro ? 0.32 : 0.18));
    const logoAltura = Math.round(logoLargura * ((logo.naturalHeight || logo.height) / (logo.naturalWidth || logo.width) || 1));
    const margem = Math.round(largura * 0.03);

    let x, y;
    switch (posicao) {
      case 'centro':
        x = (largura - logoLargura) / 2;
        y = (altura - logoAltura) / 2;
        break;
      case 'superior-esquerda':
        x = margem; y = margem;
        break;
      case 'superior-direita':
        x = largura - logoLargura - margem; y = margem;
        break;
      case 'inferior-esquerda':
        x = margem; y = altura - logoAltura - margem;
        break;
      case 'inferior-direita':
      default:
        x = largura - logoLargura - margem; y = altura - logoAltura - margem;
        break;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    // sombra suave por trás da logo, pra manter contraste tanto em fotos
    // claras (fachada branca, céu) quanto escuras (ambientes internos)
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.max(4, Math.round(logoLargura * 0.05));
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.drawImage(logo, x, y, logoLargura, logoAltura);
    ctx.restore();
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  const nomeBase = file.name.replace(/\.[^.]+$/, '') || 'foto';
  return new File([blob], `${nomeBase}-marcadagua.jpg`, { type: 'image/jpeg' });
}

// =====================================================================
// EQUIPE
// =====================================================================
async function loadEquipe() {
  const tbody = $('#equipeTable tbody');
  const { data, error } = await supabase.from('usuarios').select('*').order('nome');
  if (error) { tbody.innerHTML = emptyRow(9, 'Erro ao carregar a equipe.'); console.error(error); return; }
  if (!data.length) { tbody.innerHTML = emptyRow(9, 'Nenhum integrante cadastrado ainda.'); return; }

  tbody.innerHTML = data.map((u) => `
    <tr>
      <td>${u.foto_url ? `<img class="table-avatar" src="${u.foto_url}">` : `<span class="table-avatar-placeholder">${(u.nome || '?').split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase()}</span>`}</td>
      <td><strong>${u.nome}</strong></td>
      <td>${u.cargo}</td>
      <td>${u.email}</td>
      <td>${u.ativo ? '✅' : '—'}</td>
      <td>${u.recebe_leads === false ? '<span class="badge-oculto">Pausado</span>' : '✅'}</td>
      <td>${u.visivel_no_site === false ? '<span class="badge-oculto">Oculto do site</span>' : '—'}</td>
      <td class="nav-financeiro" ${podeVerFinanceiro ? '' : 'hidden'}>
        ${u.auth_user_id
          ? '<span class="badge-oculto" style="background:rgba(22,167,102,.15);color:#16a766;">✅ Vinculado</span>'
          : `<button class="btn btn-ghost btn-sm" data-action="usuario-criar-acesso" data-id="${u.id}" data-email="${u.email}">Criar acesso</button>`}
      </td>
      <td class="nav-financeiro" ${podeVerFinanceiro ? '' : 'hidden'}>
        <button class="btn btn-ghost btn-sm" data-action="usuario-edit" data-id="${u.id}">Editar</button>
        ${u.auth_user_id ? `<button class="btn btn-ghost btn-sm" data-action="usuario-redefinir-senha" data-id="${u.id}" data-nome="${u.nome}">Redefinir senha</button>` : ''}
        ${souGerente ? `<button class="btn btn-danger btn-sm" data-action="usuario-delete" data-id="${u.id}">Excluir</button>` : ''}
      </td>
    </tr>
  `).join('');
}

function usuarioForm(u = {}) {
  return `
    <h2>${u.id ? 'Editar integrante' : 'Novo integrante'}</h2>
    <form class="modal-form" id="usuarioForm">
      <input type="hidden" id="u-id" value="${u.id || ''}">
      <div class="form-row full upload-row">
        <label>Foto</label>
        <img class="upload-preview" id="u-foto-preview" src="${u.foto_url || ''}" style="${u.foto_url ? '' : 'display:none'}">
        <input type="file" id="u-foto-file" accept="image/*">
      </div>
      <div class="form-row full"><label>Nome</label><input required id="u-nome" value="${u.nome || ''}"></div>
      <div class="form-row"><label>E-mail (mesmo do login)</label><input required type="email" id="u-email" value="${u.email || ''}"></div>
      <div class="form-row"><label>Telefone</label><input id="u-telefone" value="${u.telefone || ''}"></div>
      <div class="form-row"><label>CRECI</label><input id="u-creci" value="${u.creci || ''}"></div>
      <div class="form-row"><label>Cargo</label>
        <select id="u-cargo">
          <option value="admin" ${u.cargo === 'admin' ? 'selected' : ''}>Admin</option>
          <option value="gerente" ${u.cargo === 'gerente' ? 'selected' : ''}>Gerente</option>
          <option value="corretor" ${!u.cargo || u.cargo === 'corretor' ? 'selected' : ''}>Corretor</option>
          <option value="atendente" ${u.cargo === 'atendente' ? 'selected' : ''}>Atendente</option>
          <option value="analista_doc" ${u.cargo === 'analista_doc' ? 'selected' : ''}>Analista de Documentação</option>
        </select>
      </div>
      <div class="form-row"><label>Meta mensal (R$ em comissão)</label><input type="number" id="u-meta" value="${u.meta_mensal ?? ''}"></div>
      <div class="form-row full"><label class="check-row"><input type="checkbox" id="u-ativo" ${u.ativo !== false ? 'checked' : ''}> Ativo</label></div>
      <div class="form-row full"><label class="check-row"><input type="checkbox" id="u-recebe-leads" ${u.recebe_leads !== false ? 'checked' : ''}> Recebe leads na roleta automática</label></div>
      <p style="grid-column:1/-1;font-size:.78rem;color:var(--gray-text);margin-top:-8px;">Desmarque pra tirar temporariamente esse corretor do rodízio de novos leads (ex: férias, fora do escritório) sem desativar o acesso dele ao sistema.</p>
      <div class="form-row full"><label class="check-row"><input type="checkbox" id="u-visivel-site" ${(u.id ? u.visivel_no_site !== false : false) ? 'checked' : ''}> Aparecer na página de equipe do site</label></div>
      ${!u.id ? '<p style="grid-column:1/-1;font-size:.78rem;color:var(--gray-text);">Novo integrante começa oculto do site — marque a opção acima quando quiser publicá-lo. Depois de salvar, crie o login dele em Supabase → Authentication → Users com esse mesmo e-mail, para ele conseguir acessar o CRM.</p>' : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelUsuario">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  `;
}

$('#newUsuarioBtn').addEventListener('click', () => { openModal(usuarioForm()); bindUsuarioForm(); });

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'usuario-edit') {
    const { data: u } = await supabase.from('usuarios').select('*').eq('id', e.target.dataset.id).single();
    if (!u) return;
    openModal(usuarioForm(u));
    bindUsuarioForm();
  }
  if (e.target.dataset.action === 'usuario-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir integrantes da equipe.', true); return; }
    if (!confirm('Remover este integrante da equipe? O login dele no Supabase Auth precisa ser removido separadamente, se quiser bloquear o acesso.')) return;
    const { error } = await supabase.from('usuarios').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Integrante removido.');
    loadEquipe();
  }
  if (e.target.dataset.action === 'usuario-criar-acesso') {
    const senha = window.prompt('Senha inicial para este integrante (mínimo 6 caracteres).\nDeixe em branco se ele já tiver um login criado direto no Supabase com esse e-mail — o sistema só vai vincular.', '');
    if (senha === null) return; // cancelou
    if (senha && senha.length < 6) { toast('A senha precisa ter pelo menos 6 caracteres.', true); return; }
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Criando...';
    const { data, error } = await supabase.functions.invoke('criar-acesso-usuario', {
      body: { usuarioId: e.target.dataset.id, email: e.target.dataset.email, senha },
    });
    if (error || data?.error) {
      let msg = data?.error;
      if (!msg) { try { const corpo = await error.context?.json?.(); msg = corpo?.error; } catch { /* ignora */ } }
      toast('Erro: ' + (msg || error?.message || 'não foi possível criar o acesso.'), true);
      btn.disabled = false; btn.textContent = 'Criar acesso';
      return;
    }
    toast(data.acao === 'vinculado' ? 'Login existente vinculado com sucesso.' : 'Acesso criado com sucesso.');
    loadEquipe();
  }
  if (e.target.dataset.action === 'usuario-redefinir-senha') {
    const novaSenha = window.prompt(`Nova senha para ${e.target.dataset.nome} (mínimo 6 caracteres):`, '');
    if (novaSenha === null) return; // cancelou
    if (novaSenha.length < 6) { toast('A senha precisa ter pelo menos 6 caracteres.', true); return; }
    const confirmar = window.prompt('Digite a mesma senha de novo, para confirmar:', '');
    if (confirmar === null) return;
    if (confirmar !== novaSenha) { toast('As senhas digitadas não bateram. Tente de novo.', true); return; }
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Salvando...';
    const { data, error } = await supabase.functions.invoke('redefinir-senha-usuario', {
      body: { usuarioId: e.target.dataset.id, novaSenha },
    });
    if (error || data?.error) {
      let msg = data?.error;
      if (!msg) { try { const corpo = await error.context?.json?.(); msg = corpo?.error; } catch { /* ignora */ } }
      toast('Erro: ' + (msg || error?.message || 'não foi possível redefinir a senha.'), true);
      btn.disabled = false; btn.textContent = 'Redefinir senha';
      return;
    }
    toast(`Senha de ${data.nome} redefinida com sucesso.`);
    btn.disabled = false; btn.textContent = 'Redefinir senha';
  }
});

function bindUsuarioForm() {
  $('#cancelUsuario').addEventListener('click', closeModal);
  $('#u-foto-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = $('#u-foto-preview');
    preview.src = URL.createObjectURL(file);
    preview.style.display = '';
  });

  $('#usuarioForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#u-id').value;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    let fotoUrl = $('#u-foto-preview').src && $('#u-foto-preview').style.display !== 'none' ? $('#u-foto-preview').getAttribute('src') : null;
    const file = $('#u-foto-file').files[0];
    try {
      if (file) fotoUrl = await uploadImagem(file, 'equipe');
    } catch (err) {
      toast('Erro ao enviar a foto: ' + err.message, true);
      btn.disabled = false; btn.textContent = 'Salvar';
      return;
    }

    const payload = {
      nome: $('#u-nome').value.trim(),
      email: $('#u-email').value.trim(),
      telefone: $('#u-telefone').value.trim() || null,
      creci: $('#u-creci').value.trim() || null,
      cargo: $('#u-cargo').value,
      meta_mensal: $('#u-meta').value ? Number($('#u-meta').value) : null,
      ativo: $('#u-ativo').checked,
      recebe_leads: $('#u-recebe-leads').checked,
      visivel_no_site: $('#u-visivel-site').checked,
      foto_url: fotoUrl && fotoUrl.startsWith('blob:') ? null : fotoUrl,
    };
    if (!id && !payload.foto_url) delete payload.foto_url;

    const { error } = id
      ? await supabase.from('usuarios').update(payload).eq('id', id)
      : await supabase.from('usuarios').insert(payload);

    btn.disabled = false;
    btn.textContent = 'Salvar';

    if (error) { toast('Erro ao salvar: ' + error.message, true); console.error(error); return; }
    toast('Integrante salvo com sucesso.');
    closeModal();
    loadEquipe();
  });
}

// =====================================================================
// DEPOIMENTOS
// =====================================================================
async function loadDepoimentos() {
  const tbody = $('#depoimentosTable tbody');
  const { data, error } = await supabase.from('depoimentos').select('*').order('ordem').order('criado_em', { ascending: false });
  if (error) { tbody.innerHTML = emptyRow(6, 'Erro ao carregar depoimentos.'); console.error(error); return; }
  if (!data.length) { tbody.innerHTML = emptyRow(6, 'Nenhum depoimento cadastrado ainda.'); return; }

  tbody.innerHTML = data.map((d) => `
    <tr>
      <td>${d.foto_url ? `<img class="table-avatar" src="${d.foto_url}">` : `<span class="table-avatar-placeholder">${(d.nome_cliente || '?')[0].toUpperCase()}</span>`}</td>
      <td><strong>${d.nome_cliente}</strong></td>
      <td>${(d.texto || '').slice(0, 60)}${d.texto?.length > 60 ? '…' : ''}</td>
      <td>${'★'.repeat(d.nota)}${'☆'.repeat(5 - d.nota)}</td>
      <td>${d.publicado ? '✅' : '—'}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="depoimento-edit" data-id="${d.id}">Editar</button>
        ${souGerente ? `<button class="btn btn-danger btn-sm" data-action="depoimento-delete" data-id="${d.id}">Excluir</button>` : ''}
      </td>
    </tr>
  `).join('');
}

function depoimentoForm(d = {}) {
  return `
    <h2>${d.id ? 'Editar depoimento' : 'Novo depoimento'}</h2>
    <form class="modal-form" id="depoimentoForm">
      <input type="hidden" id="d-id" value="${d.id || ''}">
      <div class="form-row full upload-row">
        <label>Foto do cliente (opcional)</label>
        <img class="upload-preview" id="d-foto-preview" src="${d.foto_url || ''}" style="${d.foto_url ? '' : 'display:none'}">
        <input type="file" id="d-foto-file" accept="image/*">
      </div>
      <div class="form-row full"><label>Nome do cliente</label><input required id="d-nome" value="${d.nome_cliente || ''}"></div>
      <div class="form-row full"><label>Depoimento</label><textarea required id="d-texto" rows="3">${d.texto || ''}</textarea></div>
      <div class="form-row"><label>Nota (1 a 5)</label><input type="number" min="1" max="5" id="d-nota" value="${d.nota || 5}"></div>
      <div class="form-row"><label class="check-row"><input type="checkbox" id="d-publicado" ${d.publicado !== false ? 'checked' : ''}> Publicado no site</label></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelDepoimento">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  `;
}

$('#newDepoimentoBtn').addEventListener('click', () => { openModal(depoimentoForm()); bindDepoimentoForm(); });

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'depoimento-edit') {
    const { data: d } = await supabase.from('depoimentos').select('*').eq('id', e.target.dataset.id).single();
    if (!d) return;
    openModal(depoimentoForm(d));
    bindDepoimentoForm();
  }
  if (e.target.dataset.action === 'depoimento-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir depoimentos.', true); return; }
    if (!confirm('Excluir este depoimento?')) return;
    const { error } = await supabase.from('depoimentos').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Depoimento excluído.');
    loadDepoimentos();
  }
});

function bindDepoimentoForm() {
  $('#cancelDepoimento').addEventListener('click', closeModal);
  $('#d-foto-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = $('#d-foto-preview');
    preview.src = URL.createObjectURL(file);
    preview.style.display = '';
  });

  $('#depoimentoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#d-id').value;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    let fotoUrl = $('#d-foto-preview').style.display !== 'none' ? $('#d-foto-preview').getAttribute('src') : null;
    const file = $('#d-foto-file').files[0];
    try {
      if (file) fotoUrl = await uploadImagem(file, 'depoimentos');
    } catch (err) {
      toast('Erro ao enviar a foto: ' + err.message, true);
      btn.disabled = false; btn.textContent = 'Salvar';
      return;
    }
    if (fotoUrl && fotoUrl.startsWith('blob:')) fotoUrl = null;

    const payload = {
      nome_cliente: $('#d-nome').value.trim(),
      texto: $('#d-texto').value.trim(),
      nota: Number($('#d-nota').value) || 5,
      publicado: $('#d-publicado').checked,
      foto_url: fotoUrl,
    };

    const { error } = id
      ? await supabase.from('depoimentos').update(payload).eq('id', id)
      : await supabase.from('depoimentos').insert(payload);

    btn.disabled = false;
    btn.textContent = 'Salvar';

    if (error) { toast('Erro ao salvar: ' + error.message, true); console.error(error); return; }
    toast('Depoimento salvo com sucesso.');
    closeModal();
    loadDepoimentos();
  });
}

// =====================================================================
// FOTOS DO SITE (HERO)
// =====================================================================
async function loadHero() {
  const gallery = $('#heroGallery');
  const { data, error } = await supabase.from('hero_imagens').select('*').order('ordem').order('criado_em', { ascending: false });
  if (error) { gallery.innerHTML = '<p class="table-empty">Erro ao carregar as fotos.</p>'; console.error(error); return; }
  if (!data.length) { gallery.innerHTML = '<p class="table-empty">Nenhuma foto cadastrada ainda — o site vai mostrar as ilustrações padrão.</p>'; return; }

  gallery.innerHTML = data.map((h) => `
    <div class="hero-gallery-card">
      <div class="hero-gallery-thumb"><img src="${h.url}" alt="${h.legenda || ''}"></div>
      <div class="hero-gallery-body">
        <label class="check-row"><input type="checkbox" data-action="hero-toggle" data-id="${h.id}" ${h.ativo ? 'checked' : ''}> Ativa no site</label>
        ${souGerente ? `<button class="btn btn-danger btn-sm" data-action="hero-delete" data-id="${h.id}">Excluir</button>` : ''}
      </div>
    </div>
  `).join('');
}

function heroForm() {
  return `
    <h2>Nova foto do site</h2>
    <form class="modal-form" id="heroForm">
      <div class="form-row full upload-row">
        <label>Imagem</label>
        <img class="upload-preview" id="h-foto-preview" style="display:none">
        <input required type="file" id="h-foto-file" accept="image/*">
      </div>
      <div class="form-row full"><label>Legenda (opcional)</label><input id="h-legenda" placeholder="Ex: Entrega das chaves - família Silva"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelHero">Cancelar</button>
        <button type="submit" class="btn btn-primary">Adicionar</button>
      </div>
    </form>
  `;
}

$('#newHeroBtn').addEventListener('click', () => {
  openModal(heroForm());
  $('#cancelHero').addEventListener('click', closeModal);
  $('#h-foto-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = $('#h-foto-preview');
    preview.src = URL.createObjectURL(file);
    preview.style.display = '';
  });

  $('#heroForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const file = $('#h-foto-file').files[0];
    if (!file) return;

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      const url = await uploadImagem(file, 'hero');
      const { error } = await supabase.from('hero_imagens').insert({ url, legenda: $('#h-legenda').value.trim() || null });
      if (error) throw error;
      toast('Foto adicionada ao site.');
      closeModal();
      loadHero();
    } catch (err) {
      toast('Erro ao enviar a foto: ' + err.message, true);
      btn.disabled = false;
      btn.textContent = 'Adicionar';
    }
  });
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset.action === 'hero-toggle') {
    const { error } = await supabase.from('hero_imagens').update({ ativo: e.target.checked }).eq('id', e.target.dataset.id);
    if (error) toast('Não foi possível atualizar.', true);
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'hero-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir fotos do site.', true); return; }
    if (!confirm('Excluir esta foto do site?')) return;
    const { error } = await supabase.from('hero_imagens').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Foto excluída.');
    loadHero();
  }
});

// =====================================================================
// MOMENTOS DOS CLIENTES (assinatura de contrato + entrega de chaves)
// Aparecem no site público, seção "Momentos". Tabela: entregas_chaves.
// =====================================================================
const MOMENTO_TIPO_LABEL = { assinatura: '✍️ Assinatura de contrato', entrega_chaves: '🔑 Entrega de chaves' };
let momentosCache = [];

async function loadMomentosCRM() {
  const gallery = $('#momentosGallery');
  const { data, error } = await supabase.from('entregas_chaves').select('*')
    .order('tipo').order('ordem').order('criado_em', { ascending: false });
  if (error) { gallery.innerHTML = '<p class="table-empty">Erro ao carregar as fotos.</p>'; console.error(error); return; }
  momentosCache = data || [];
  renderMomentosCRM();
}

function renderMomentosCRM() {
  const gallery = $('#momentosGallery');
  const filtro = $('#momentosFiltroTipo')?.value || '';
  const lista = filtro ? momentosCache.filter((m) => m.tipo === filtro) : momentosCache;
  if (!lista.length) {
    gallery.innerHTML = `<p class="table-empty">${momentosCache.length ? 'Nenhuma foto para esse filtro.' : 'Nenhuma foto cadastrada ainda.'}</p>`;
    return;
  }
  gallery.innerHTML = lista.map((m) => `
    <div class="hero-gallery-card">
      <div class="hero-gallery-thumb"><img src="${m.foto_url}" alt=""></div>
      <div class="hero-gallery-body">
        <span class="badge-mini">${MOMENTO_TIPO_LABEL[m.tipo] || m.tipo}</span>
        <label class="check-row"><input type="checkbox" data-action="momento-toggle" data-id="${m.id}" ${m.publicado ? 'checked' : ''}> Publicada no site</label>
        <label class="momento-ordem">Ordem <input type="number" data-action="momento-ordem" data-id="${m.id}" value="${m.ordem ?? 0}"></label>
        ${souGerente ? `<button class="btn btn-danger btn-sm" data-action="momento-delete" data-id="${m.id}">Excluir</button>` : ''}
      </div>
    </div>
  `).join('');
}

$('#momentosFiltroTipo')?.addEventListener('change', renderMomentosCRM);

function momentoForm() {
  return `
    <h2>Nova foto de momento</h2>
    <form class="modal-form" id="momentoForm">
      <div class="form-row"><label>Tipo</label>
        <select id="m-tipo">
          <option value="assinatura">✍️ Assinatura de contrato</option>
          <option value="entrega_chaves">🔑 Entrega de chaves</option>
        </select>
      </div>
      <div class="form-row full upload-row">
        <label>Foto</label>
        <img class="upload-preview" id="m-foto-preview" style="display:none">
        <input required type="file" id="m-foto-file" accept="image/*">
      </div>
      <div class="form-row"><label>Nome do cliente (opcional)</label><input id="m-nome"></div>
      <div class="form-row"><label>Imóvel (opcional)</label><input id="m-imovel"></div>
      <div class="form-row"><label>Data (opcional)</label><input type="date" id="m-data"></div>
      <div class="form-row full"><label class="check-row"><input type="checkbox" id="m-publicado" checked> Publicar no site já</label></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelMomento">Cancelar</button>
        <button type="submit" class="btn btn-primary">Adicionar</button>
      </div>
    </form>
  `;
}

$('#newMomentoBtn')?.addEventListener('click', () => {
  openModal(momentoForm());
  $('#cancelMomento').addEventListener('click', closeModal);
  $('#m-foto-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = $('#m-foto-preview');
    preview.src = URL.createObjectURL(file);
    preview.style.display = '';
  });
  $('#momentoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const file = $('#m-foto-file').files[0];
    if (!file) return;
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      const url = await uploadImagem(file, 'entregas-assinaturas');
      const { error } = await supabase.from('entregas_chaves').insert({
        tipo: $('#m-tipo').value,
        foto_url: url,
        nome_cliente: $('#m-nome').value.trim() || null,
        imovel_titulo: $('#m-imovel').value.trim() || null,
        data_entrega: $('#m-data').value || null,
        publicado: $('#m-publicado').checked,
      });
      if (error) throw error;
      toast('Foto adicionada.');
      closeModal();
      loadMomentosCRM();
    } catch (err) {
      toast('Erro ao enviar a foto: ' + err.message, true);
      btn.disabled = false; btn.textContent = 'Adicionar';
    }
  });
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset.action === 'momento-toggle') {
    const { error } = await supabase.from('entregas_chaves').update({ publicado: e.target.checked }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível atualizar.', true); e.target.checked = !e.target.checked; return; }
    toast(e.target.checked ? 'Publicada no site.' : 'Removida do site.');
    const item = momentosCache.find((m) => m.id === e.target.dataset.id);
    if (item) item.publicado = e.target.checked;
  }
  if (e.target.dataset.action === 'momento-ordem') {
    const val = Number(e.target.value) || 0;
    const { error } = await supabase.from('entregas_chaves').update({ ordem: val }).eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível salvar a ordem.', true); return; }
    const item = momentosCache.find((m) => m.id === e.target.dataset.id);
    if (item) item.ordem = val;
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'momento-delete') {
    if (!souGerente) { toast('Somente o gerente pode excluir fotos.', true); return; }
    if (!confirm('Excluir esta foto? Ela sai do site na hora.')) return;
    const { error } = await supabase.from('entregas_chaves').delete().eq('id', e.target.dataset.id);
    if (error) { toast('Não foi possível excluir.', true); return; }
    toast('Foto excluída.');
    loadMomentosCRM();
  }
});

// =====================================================================
// CONTEÚDO DO SITE (sobre, alugar/vender, rodapé, redes sociais)
// =====================================================================
async function loadConfigSite() {
  const { data, error } = await supabase.from('config_site').select('*').eq('id', 1).maybeSingle();
  if (error || !data) { toast('Não foi possível carregar o conteúdo do site.', true); console.error(error); return; }

  $('#cs-sobre').value = data.sobre_nos_texto || '';
  $('#cs-alugar-texto').value = data.alugar_vender_texto || '';
  $('#cs-alugar-servicos').value = (data.alugar_vender_servicos || []).join(', ');
  $('#cs-alugar-fechamento').value = data.alugar_vender_fechamento || '';
  $('#cs-rodape-descricao').value = data.rodape_descricao || '';
  $('#cs-endereco').value = data.endereco || '';
  $('#cs-horario').value = data.horario_funcionamento || '';
  $('#cs-whatsapp').value = data.whatsapp_telefone || '';
  $('#cs-whatsapp-secundario').value = data.whatsapp_secundario || '';
  $('#cs-telefone-fixo').value = data.telefone_fixo || '';
  $('#cs-email').value = data.email || '';
  $('#cs-creci').value = data.creci || '';
  $('#cs-razao-social').value = data.razao_social || '';
  $('#cs-cnpj').value = data.cnpj || '';
  $('#cs-ir-inicio').value = data.ir_declaracao_inicio || '';
  $('#cs-ir-fim').value = data.ir_declaracao_fim || '';
  $('#cs-cidade').value = data.cidade || 'Fazenda Rio Grande';
  $('#cs-estado').value = data.estado || 'PR';
  $('#cs-instagram').value = data.instagram_url || '';
  $('#cs-facebook').value = data.facebook_url || '';
  $('#cs-whatsapp-url').value = data.whatsapp_url || '';
  $('#cs-youtube').value = data.youtube_url || '';

  // só gerente/admin pode editar (a regra real é garantida pelo banco via RLS)
  $$('#configSiteForm input, #configSiteForm textarea').forEach((el) => { el.disabled = !podeVerFinanceiro; });
  const btnSalvar = $('#configSiteForm button[type="submit"]');
  if (btnSalvar) btnSalvar.hidden = !podeVerFinanceiro;
}

$('#configSiteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const payload = {
    sobre_nos_texto: $('#cs-sobre').value.trim() || null,
    alugar_vender_texto: $('#cs-alugar-texto').value.trim() || null,
    alugar_vender_servicos: $('#cs-alugar-servicos').value.split(',').map((s) => s.trim()).filter(Boolean),
    alugar_vender_fechamento: $('#cs-alugar-fechamento').value.trim() || null,
    rodape_descricao: $('#cs-rodape-descricao').value.trim() || null,
    endereco: $('#cs-endereco').value.trim() || null,
    horario_funcionamento: $('#cs-horario').value.trim() || null,
    whatsapp_telefone: $('#cs-whatsapp').value.trim() || null,
    whatsapp_secundario: $('#cs-whatsapp-secundario').value.trim() || null,
    telefone_fixo: $('#cs-telefone-fixo').value.trim() || null,
    email: $('#cs-email').value.trim() || null,
    creci: $('#cs-creci').value.trim() || null,
    razao_social: $('#cs-razao-social').value.trim() || null,
    cnpj: $('#cs-cnpj').value.trim() || null,
    ir_declaracao_inicio: $('#cs-ir-inicio').value || null,
    ir_declaracao_fim: $('#cs-ir-fim').value || null,
    cidade: $('#cs-cidade').value.trim() || 'Fazenda Rio Grande',
    estado: $('#cs-estado').value.trim().toUpperCase() || 'PR',
    instagram_url: $('#cs-instagram').value.trim() || null,
    facebook_url: $('#cs-facebook').value.trim() || null,
    whatsapp_url: $('#cs-whatsapp-url').value.trim() || null,
    youtube_url: $('#cs-youtube').value.trim() || null,
  };

  const { error } = await supabase.from('config_site').update(payload).eq('id', 1);
  btn.disabled = false;
  btn.textContent = 'Salvar conteúdo do site';
  if (error) { toast('Não foi possível salvar (só gerente/admin pode editar).', true); console.error(error); return; }
  toast('Conteúdo do site atualizado.');
});


// =====================================================================
// RELATÓRIOS (download em Excel .xlsx) — acesso gerente/admin
// =====================================================================
function dataHojeArquivo() {
  return new Date().toISOString().slice(0, 10);
}

function baixarArquivo(nomeArquivo, conteudo, mime) {
  const blob = new Blob([conteudo], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Gera e baixa uma planilha .xlsx de verdade (abre direto no Excel, sem passar por CSV)
function baixarExcel(nomeArquivo, headers, linhas, nomeAba) {
  try {
    const planilha = XLSX.utils.aoa_to_sheet([headers, ...linhas]);
    planilha['!cols'] = headers.map((_, i) => {
      const maiorConteudo = Math.max(
        headers[i]?.length || 10,
        ...linhas.map((l) => String(l[i] ?? '').length)
      );
      return { wch: Math.min(Math.max(maiorConteudo + 2, 10), 45) };
    });
    const workbook = XLSX.utils.book_new();
    // nome de aba do Excel não pode ter : \ / ? * [ ]
    const nomeAbaSeguro = (nomeAba || 'Relatório').replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Relatório';
    XLSX.utils.book_append_sheet(workbook, planilha, nomeAbaSeguro);
    XLSX.writeFile(workbook, nomeArquivo);
  } catch (err) {
    console.error('Erro ao gerar Excel:', err);
    toast('Não foi possível gerar o Excel: ' + err.message, true);
  }
}

const RELATORIOS = [
  { id: 'financeiro', titulo: '💰 Financeiro', desc: 'Cobranças de aluguel — vencimento, pagamento e atraso', tipo: 'financeiro' },
  { id: 'pessoas', titulo: '👤 Pessoas (todas)', desc: 'Todos os cadastros de pessoas do CRM', tipo: 'pessoas', papel: null },
  { id: 'proprietarios', titulo: '🏠 Proprietários', desc: 'Donos de imóveis cadastrados', tipo: 'pessoas', papel: 'proprietario' },
  { id: 'locadores', titulo: '🔑 Locadores', desc: 'Quem coloca o imóvel para alugar', tipo: 'pessoas', papel: 'locador' },
  { id: 'locatarios', titulo: '🏘️ Locatários / Inquilinos', desc: 'Quem está alugando um imóvel', tipo: 'pessoas', papel: 'inquilino' },
  { id: 'compradores', titulo: '🛒 Compradores', desc: 'Interessados e clientes em compra', tipo: 'pessoas', papel: 'comprador' },
  { id: 'vendedores', titulo: '📤 Vendedores', desc: 'Quem está vendendo um imóvel', tipo: 'pessoas', papel: 'vendedor' },
  { id: 'construtores', titulo: '👷 Construtores', desc: 'Construtores parceiros cadastrados', tipo: 'pessoas', papel: 'construtor' },
  { id: 'construtoras', titulo: '🏗️ Construtoras / Incorporadoras', desc: 'Empresas incorporadoras e construtoras', tipo: 'pessoas', papel: 'incorporadora' },
];

function carregarRelatorios() {
  if (!podeVerFinanceiro) { $('#relatoriosGrid').innerHTML = '<p class="table-empty">Acesso restrito a gerente e administrador.</p>'; return; }
  const grid = $('#relatoriosGrid');
  grid.innerHTML = RELATORIOS.map((r) => `
    <button class="relatorio-card" data-relatorio="${r.id}">
      <strong>${r.titulo}</strong>
      <span>${r.desc}</span>
    </button>
  `).join('') + `
    <button class="relatorio-card destaque" id="btnBackupLocaticio">
      <strong>🗄️ Backup — Gestão Locatícia</strong>
      <span>Exporta contratos de locação e cobranças em um arquivo JSON</span>
    </button>
  `;
}

async function baixarRelatorioPessoas(papel, idRelatorio, tituloAmigavel) {
  if (!podeVerFinanceiro) { toast('Acesso restrito a gerente e administrador.', true); return; }
  let query = supabase.from('pessoas').select('nome,telefone,email,cpf_cnpj,cidade,bairro,papeis,criado_em').order('nome');
  if (papel) query = query.contains('papeis', [papel]);
  const { data, error } = await query;
  if (error) { toast('Erro ao gerar relatório: ' + error.message, true); console.error(error); return; }
  if (!data || !data.length) { toast('Nenhum registro encontrado para este relatório.'); return; }

  const headers = ['Nome', 'Telefone', 'E-mail', 'CPF/CNPJ', 'Cidade', 'Bairro', 'Papéis', 'Cadastrado em'];
  const linhas = data.map((p) => [
    p.nome, p.telefone || '', p.email || '', p.cpf_cnpj || '', p.cidade || '', p.bairro || '',
    (p.papeis || []).join(', '), p.criado_em ? new Date(p.criado_em).toLocaleDateString('pt-BR') : '',
  ]);
  baixarExcel(`relatorio-${idRelatorio}-${dataHojeArquivo()}.xlsx`, headers, linhas, tituloAmigavel);
  toast(`Relatório "${tituloAmigavel}" baixado.`);
}

async function baixarRelatorioFinanceiro() {
  if (!podeVerFinanceiro) { toast('Acesso restrito a gerente e administrador.', true); return; }
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*, contratos(imoveis(titulo), pessoas!contratos_comprador_locatario_id_fkey(nome))')
    .order('data_vencimento', { ascending: false });
  if (error) { toast('Erro ao gerar relatório: ' + error.message, true); console.error(error); return; }
  if (!data || !data.length) { toast('Nenhuma cobrança encontrada.'); return; }

  const headers = ['Imóvel', 'Cliente', 'Referência', 'Vencimento', 'Valor base', 'Pago em', 'Status'];
  const linhas = data.map((cb) => {
    const contrato = cb.contratos || {};
    const statusReal = cb.data_pagamento ? 'pago' : (diasEmAtraso(cb.data_vencimento, cb.data_pagamento) > 0 ? 'atrasado' : 'pendente');
    return [
      contrato.imoveis?.titulo || '', contrato.pessoas?.nome || '',
      cb.referencia ? new Date(cb.referencia + 'T00:00:00').toLocaleDateString('pt-BR', { month: '2-digit', year: 'numeric' }) : '',
      cb.data_vencimento ? new Date(cb.data_vencimento + 'T00:00:00').toLocaleDateString('pt-BR') : '',
      cb.valor_base ?? '', cb.data_pagamento ? new Date(cb.data_pagamento + 'T00:00:00').toLocaleDateString('pt-BR') : '', statusReal,
    ];
  });
  baixarExcel(`relatorio-financeiro-${dataHojeArquivo()}.xlsx`, headers, linhas, 'Financeiro');
  toast('Relatório financeiro baixado.');
}

async function baixarBackupLocaticio() {
  if (!podeVerFinanceiro) { toast('Acesso restrito a gerente e administrador.', true); return; }
  const [{ data: contratos, error: erroContratos }, { data: cobrancas, error: erroCobrancas }] = await Promise.all([
    supabase.from('contratos').select('*, imoveis(titulo), pessoas!contratos_comprador_locatario_id_fkey(nome)').eq('tipo', 'locacao'),
    supabase.from('cobrancas').select('*, contratos!inner(tipo, imoveis(titulo))').eq('contratos.tipo', 'locacao'),
  ]);
  if (erroContratos || erroCobrancas) { toast('Erro ao gerar backup.', true); console.error(erroContratos || erroCobrancas); return; }

  const backup = {
    gerado_em: new Date().toISOString(),
    contratos_locacao: contratos || [],
    cobrancas_locacao: cobrancas || [],
  };
  baixarArquivo(`backup-gestao-locaticia-${dataHojeArquivo()}.json`, JSON.stringify(backup, null, 2), 'application/json');
  toast('Backup da gestão locatícia baixado.');
}

document.addEventListener('click', async (e) => {
  const cardRelatorio = e.target.closest('[data-relatorio]');
  if (cardRelatorio) {
    const conf = RELATORIOS.find((r) => r.id === cardRelatorio.dataset.relatorio);
    if (!conf) return;
    if (conf.tipo === 'financeiro') await baixarRelatorioFinanceiro();
    else await baixarRelatorioPessoas(conf.papel, conf.id, conf.titulo.replace(/^[^\w]+/, '').trim());
  }
  if (e.target.closest('#btnBackupLocaticio')) {
    await baixarBackupLocaticio();
  }
});

// =====================================================================
// HISTÓRICO DE DOCUMENTOS (gerente/admin) — todo documento em PDF gerado
// pelos corretores no Gerador de Documentos, para acompanhamento e análise
// =====================================================================
let historicoDocsFiltrosCarregados = false;

async function carregarFiltrosHistoricoDocs() {
  if (historicoDocsFiltrosCarregados) return;
  const { data: corretores } = await supabase.from('usuarios').select('id,nome').order('nome');
  const selectCorretor = $('#historicoDocsFiltroCorretor');
  if (selectCorretor && corretores) {
    selectCorretor.innerHTML = '<option value="">Todos os corretores</option>'
      + corretores.map((u) => `<option value="${u.id}">${u.nome}</option>`).join('');
  }
  const selectModelo = $('#historicoDocsFiltroModelo');
  if (selectModelo) {
    selectModelo.innerHTML = '<option value="">Todos os modelos</option>'
      + MODELOS_DOC.map((m) => `<option value="${m.id}">${m.titulo}</option>`).join('');
  }
  historicoDocsFiltrosCarregados = true;
}

async function carregarHistoricoDocumentos() {
  const tbody = $('#historicoDocsTable tbody');
  if (!podeVerFinanceiro) { tbody.innerHTML = emptyRow(7, 'Acesso restrito a gerente e administrador.'); return; }  await carregarFiltrosHistoricoDocs();

  const corretorId = $('#historicoDocsFiltroCorretor').value;
  const modeloId = $('#historicoDocsFiltroModelo').value;
  const dataDe = $('#historicoDocsFiltroDe').value;
  const dataAte = $('#historicoDocsFiltroAte').value;

  let query = supabase.from('documentos_gerados').select('*').order('criado_em', { ascending: false }).limit(300);
  if (corretorId) query = query.eq('corretor_id', corretorId);
  if (modeloId) query = query.eq('modelo_id', modeloId);
  if (dataDe) query = query.gte('criado_em', `${dataDe}T00:00:00`);
  if (dataAte) query = query.lte('criado_em', `${dataAte}T23:59:59`);

  const { data, error } = await query;
  if (error) { tbody.innerHTML = emptyRow(7, 'Erro ao carregar histórico.'); console.error(error); return; }
  historicoDocsCache = data;

  const contagem = $('#historicoDocsContagem');
  if (contagem) contagem.textContent = data.length ? `${data.length} documento${data.length === 1 ? '' : 's'}` : '';

  if (!data.length) { tbody.innerHTML = emptyRow(7, 'Nenhum documento gerado ainda para este filtro.'); return; }

  tbody.innerHTML = data.map((d) => `
    <tr>
      <td>${dateTime(d.criado_em)}</td>
      <td>${escapeHtml(d.corretor_nome || '—')}</td>
      <td>${escapeHtml(d.modelo_titulo)}</td>
      <td>${escapeHtml(d.cliente_nome || '—')}</td>
      <td>${escapeHtml(d.nome_arquivo)}</td>
      <td>${d.atualizado_em ? `${dateTime(d.atualizado_em)}<br><span class="muted">por ${escapeHtml(d.editado_por_nome || '—')}</span>` : '—'}</td>
      <td class="table-actions-cell">
        ${d.storage_path ? `<button class="btn btn-ghost btn-sm" data-action="historico-docs-baixar" data-path="${escapeHtml(d.storage_path)}" data-arquivo="${escapeHtml(d.nome_arquivo)}">Baixar</button>` : '—'}
        ${d.dados_json ? `<button class="btn btn-ghost btn-sm" data-action="historico-docs-editar" data-id="${d.id}">Editar</button>` : `<span class="muted" title="Documento gerado antes deste recurso existir — sem dados salvos para reeditar.">Editar indisponível</span>`}
      </td>
    </tr>
  `).join('');
}

['#historicoDocsFiltroCorretor', '#historicoDocsFiltroModelo', '#historicoDocsFiltroDe', '#historicoDocsFiltroAte'].forEach((sel) => {
  $(sel)?.addEventListener('change', carregarHistoricoDocumentos);
});

document.addEventListener('click', async (e) => {
  const btnBaixar = e.target.closest('[data-action="historico-docs-baixar"]');
  if (!btnBaixar) return;
  const { data, error } = await supabase.storage
    .from(DOCUMENTOS_GERADOS_STORAGE_BUCKET)
    .createSignedUrl(btnBaixar.dataset.path, 60);
  if (error || !data?.signedUrl) { toast('Não foi possível baixar este documento: ' + (error?.message || 'arquivo indisponível'), true); return; }
  const link = document.createElement('a');
  link.href = data.signedUrl;
  link.download = btnBaixar.dataset.arquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
});

document.addEventListener('click', async (e) => {
  const btnEditar = e.target.closest('[data-action="historico-docs-editar"]');
  if (!btnEditar) return;
  const registro = historicoDocsCache.find((d) => d.id === btnEditar.dataset.id);
  if (!registro) { toast('Documento não encontrado — atualize a página e tente de novo.', true); return; }
  const modelo = MODELOS_DOC.find((m) => m.id === registro.modelo_id);
  if (!modelo) { toast('O modelo deste documento não existe mais no sistema.', true); return; }
  if (!pessoasCache.length) await loadPessoas();
  if (!imoveisCache.length) await loadImoveis();
  openModal(documentoDocForm(modelo, true), { wide: true });
  bindDocumentoDocForm(modelo, registro);
});

// =====================================================================
// AUDITORIA (gerente/admin) — quem alterou o quê e quando
// =====================================================================
async function carregarAuditoria() {
  const tbody = $('#auditoriaTable tbody');
  if (!podeVerFinanceiro) { tbody.innerHTML = emptyRow(5, 'Acesso restrito a gerente e administrador.'); return; }

  const filtro = $('#auditoriaFiltroTabela').value;
  let query = supabase.from('auditoria').select('*').order('criado_em', { ascending: false }).limit(200);
  if (filtro) query = query.eq('tabela', filtro);
  const { data, error } = await query;

  if (error) { tbody.innerHTML = emptyRow(5, 'Erro ao carregar auditoria.'); console.error(error); return; }
  if (!data.length) { tbody.innerHTML = emptyRow(5, 'Nenhum registro de auditoria ainda.'); return; }

  tbody.innerHTML = data.map((a) => `
    <tr>
      <td>${dateTime(a.criado_em)}</td>
      <td>${a.tabela}</td>
      <td>${a.acao}</td>
      <td>${a.usuario_nome || '—'}</td>
      <td><button class="btn btn-ghost btn-sm" data-action="auditoria-ver" data-id="${a.id}">Ver detalhes</button></td>
    </tr>
  `).join('');
}

$('#auditoriaFiltroTabela').addEventListener('change', carregarAuditoria);

document.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'auditoria-ver') {
    const { data: a } = await supabase.from('auditoria').select('*').eq('id', e.target.dataset.id).single();
    if (!a) return;
    openModal(`
      <h2>Auditoria — ${a.tabela} (${a.acao})</h2>
      <p><strong>Usuário:</strong> ${a.usuario_nome || '—'} · <strong>Quando:</strong> ${dateTime(a.criado_em)}</p>
      ${a.dados_antes ? `<h3 class="modal-subtitle">Antes</h3><pre class="auditoria-json">${JSON.stringify(a.dados_antes, null, 2)}</pre>` : ''}
      ${a.dados_depois ? `<h3 class="modal-subtitle">Depois</h3><pre class="auditoria-json">${JSON.stringify(a.dados_depois, null, 2)}</pre>` : ''}
    `, { persistente: false });
  }
});

// =====================================================================
// TUTORIAL DE USO DO CRM (todos têm acesso)
// =====================================================================
const TUTORIAL_TOPICOS = [
  { titulo: 'Como faço login?', texto: 'Digite o e-mail e a senha cadastrados pelo gerente/administrador na tela inicial. Se esquecer a senha, clique em "Esqueci minha senha" e siga o link enviado por e-mail.' },
  { titulo: 'O que é o Dashboard?', texto: 'É a tela inicial: mostra quantos leads novos chegaram, quantos imóveis estão disponíveis, visitas agendadas e os últimos leads recebidos.' },
  { titulo: 'Como funciona a tela de Leads?', texto: 'Lista todos os interessados que entraram em contato. Você pode filtrar por status e mudar o status de cada lead diretamente na lista, seguindo o funil: novo → 1ª/2ª/3ª tentativa → busca qualificada → visita agendada → visita feita → alterar busca → proposta → documentação → assinaturas → pós-venda (30/60/90/120 dias) ou perdido.' },
  { titulo: 'O lead quer VENDER ou LOCAR um imóvel (ou é construtora). O que faço?', texto: 'Na linha do lead, clique em "→ Captação". Abre a tela de captação já com o nome e o telefone preenchidos — é só informar o imóvel, o papel do contato (vendedor, locador, construtora ou incorporadora) e a finalidade. Ao criar, o cliente entra no Funil de Captação e fica registrado nas observações do lead que ele foi direcionado.' },
  { titulo: 'O que é o Funil de Vendas?', texto: 'É um quadro (Kanban) que mostra os leads organizados por etapa, da esquerda para a direita, até fechar a venda/locação. Cada corretor só vê os próprios leads; gerente e administrador veem e podem alterar os de todos, com um filtro para escolher um corretor específico.' },
  { titulo: 'Como cadastro um imóvel novo?', texto: 'Vá em Imóveis → "+ Novo imóvel". Preencha título, tipo, finalidade, endereço, valores, características e escolha o corretor responsável. Depois, envie as fotos e clique na estrela da foto que quer usar como capa (principal). Se tiver vídeo, cole o link do YouTube no campo próprio.' },
  { titulo: 'Como escolho a foto principal (capa) do imóvel?', texto: 'No formulário do imóvel, depois de enviar as fotos, clique na estrelinha no canto de cada miniatura. A foto marcada com a estrela dourada é a que aparece primeiro no site.' },
  { titulo: 'Quem pode mudar o corretor responsável de um imóvel?', texto: 'Qualquer corretor pode editar as demais informações do imóvel, mas somente gerente e administrador podem alterar o corretor responsável.' },
  { titulo: 'Como cadastro uma pessoa (proprietário, comprador, locatário...)?', texto: 'Vá em Pessoas → "+ Nova pessoa". Preencha nome, telefone, e-mail e CPF/CNPJ (se tiver) e marque um ou mais papéis (proprietário, inquilino, comprador, vendedor, locador, construtor, incorporadora). O sistema bloqueia o cadastro se já existir alguém com o mesmo telefone, e-mail ou CPF/CNPJ.' },
  { titulo: 'Como agendo uma visita?', texto: 'Vá em Visitas → "+ Agendar visita", escolha o imóvel, o lead e a data/horário. A visita aparece na lista com status "agendada" até ser concluída ou cancelada.' },
  { titulo: 'Como funcionam Contratos e Financeiro?', texto: 'Contratos registra vendas e locações fechadas. Financeiro mostra as cobranças mensais de aluguel. A multa e os juros por atraso NÃO são cobrados automaticamente: numa cobrança atrasada aparece o botão "Cobrar multa/juros" para você decidir aplicar ou não (os percentuais vêm do contrato). Essas duas telas só aparecem para gerente e administrador.' },
  { titulo: 'Como baixo um relatório?', texto: 'Vá em Relatórios (só gerente/admin) e clique no card do relatório desejado — financeiro, pessoas gerais, proprietários, locadores, locatários, compradores, vendedores, construtores ou construtoras/incorporadoras. O arquivo CSV baixa automaticamente e abre certinho no Excel.' },
  { titulo: 'Como faço backup da gestão locatícia?', texto: 'Em Relatórios, clique no card "Backup — Gestão Locatícia" (só gerente/admin). Ele baixa um arquivo JSON com todos os contratos de locação e cobranças, para guardar como cópia de segurança.' },
  { titulo: 'Quem pode excluir um cadastro (imóvel, pessoa, integrante da equipe, etc.)?', texto: 'Por segurança, somente quem está cadastrado como gerente pode excluir qualquer registro do CRM (imóveis, pessoas, integrantes da equipe, depoimentos e fotos do site). Administrador e corretores podem criar e editar normalmente, mas não excluir.' },
  { titulo: 'Como edito os textos e redes sociais do site?', texto: 'Em "Conteúdo do Site" (só gerente/admin), dá pra editar o texto do "Sobre Nós", da página "Alugar ou vender meu imóvel", o rodapé e os links das redes sociais (Instagram, Facebook, WhatsApp, YouTube).' },
  { titulo: 'Como adiciono fotos que giram na home do site?', texto: 'Vá em "Fotos do Site" → "+ Nova foto", envie a imagem e escreva uma legenda opcional. Use o botão "Ativa no site" para escolher quais fotos aparecem no momento.' },
  { titulo: 'Como uso o bot de ajuda (❓)?', texto: 'Clique no botão redondo com "❓" no canto da tela e digite sua dúvida em texto normal, por exemplo "como cadastro um imóvel". O bot procura nesse mesmo tutorial e responde na hora.' },
  { titulo: 'Como cadastro um lead manualmente?', texto: 'Vá em Leads → "+ Novo lead" e preencha nome, telefone, origem e interesse. Se deixar o corretor em branco, o sistema distribui automaticamente para o corretor ativo com menos leads no mês.' },
  { titulo: 'Como funciona o Funil de Vendas (Kanban)?', texto: 'Mostra os leads organizados por etapa. Ao mudar um lead para "perdido", o sistema pede o motivo da perda — isso ajuda a entender por que negócios não fecham.' },
  { titulo: 'Onde vejo o histórico de conversa com um lead?', texto: 'Clique em "Ver" na tela de Leads. Lá aparece todo o histórico de interações (ligações, WhatsApp, e-mails) e dá pra adicionar uma nova anotação.' },
  { titulo: 'Como lanço a comissão de um corretor?', texto: 'No formulário de Contrato, preencha o percentual de comissão — o valor em reais é calculado automaticamente (mas pode ser ajustado manualmente).' },
  { titulo: 'Onde vejo o repasse ao proprietário?', texto: 'Em Financeiro, logo abaixo das cobranças, tem a tabela "Repasse ao proprietário" — já calcula automaticamente o valor líquido descontando a taxa de administração.' },
  { titulo: 'Como funciona o Ranking de corretores?', texto: 'No Dashboard (só gerente/admin), mostra quantos negócios cada corretor fechou no mês, a comissão gerada e o percentual atingido da meta cadastrada em Equipe.' },
  { titulo: 'Como registro uma vistoria de entrada/saída?', texto: 'Vá em Vistorias → "+ Nova vistoria", escolha o imóvel e o tipo. Depois clique em "Abrir" para preencher o checklist ambiente por ambiente, anexar fotos e escrever o laudo final.' },
  { titulo: 'Como colho a assinatura do locatário na vistoria?', texto: 'Dentro da vistoria (botão "Abrir"), clique em "Baixar laudo (PDF) para assinatura" — gera um PDF com todos os dados, o checklist e duas linhas de assinatura (locatário e imobiliária) prontas para imprimir e assinar.' },
  { titulo: 'Como anexo um documento (RG, matrícula, contrato)?', texto: 'Ao editar uma pessoa ou um imóvel já cadastrado, aparece uma seção "Documentos anexados" onde dá pra enviar arquivos e baixar os já enviados.' },
  { titulo: 'Como gero a ficha do imóvel em PDF?', texto: 'Na tela Imóveis, clique em "Ficha PDF" na linha do imóvel desejado — baixa um PDF pronto para enviar por WhatsApp ou e-mail.' },
  { titulo: 'Como mando o link do imóvel para o cliente?', texto: 'Na tela Imóveis, clique em "🔗 Copiar link" no card do imóvel — é copiado o link de uma página só daquele imóvel (fotos, valores e detalhes), sem o menu de outros imóveis e sem a seção "imóveis parecidos". É só colar no WhatsApp do cliente. Se ele quiser ver o site inteiro, a logo e o botão "Ver o site completo" levam pra lá. O link só abre se o imóvel estiver publicado.' },
  { titulo: 'O que é a aba Auditoria?', texto: 'Mostra (só para gerente/admin) todo o histórico de criação, edição e exclusão de imóveis, pessoas, contratos e integrantes da equipe — quem fez o quê e quando.' },
  { titulo: 'Como o proprietário acompanha o aluguel dele sem ligar pra imobiliária?', texto: 'Link direto: https://gregoriomeular-site.netlify.app/portal-proprietario.html (também tem no rodapé do site). O proprietário entra só com o e-mail cadastrado (link mágico, sem senha). Para liberar o acesso na primeira vez, peça para ele fazer login uma vez, depois copie o UID gerado em Supabase → Authentication → Users e cole no campo "ID de acesso ao Portal" ao editar a pessoa em Pessoas.' },
  { titulo: 'Como o locatário acompanha o contrato e os pagamentos dele sem ligar pra imobiliária?', texto: 'Link direto: https://gregoriomeular-site.netlify.app/portal-locatario.html (também tem no rodapé do site). Mostra o contrato de locação ativo e o histórico de cobranças/boletos, com aviso de próximo vencimento. Mesmo processo de liberação: login com e-mail (link mágico), depois cole o UID do Supabase no campo "ID de acesso ao Portal" da pessoa.' },
  { titulo: 'Para que serve a aba Aprovações?', texto: 'É onde a analista de documentação acompanha cada cliente em processo de aprovação — financiamento bancário (correspondente), aprovação com loteadora ou cartório/registro. Cada processo tem cliente, vendedor, imóvel, corretor que colheu os documentos, instituição envolvida, status com histórico de datas e os documentos anexados. Os corretores veem (só leitura) o andamento dos processos dos próprios clientes.' },
  { titulo: 'Quem tem acesso à aba Aprovações?', texto: 'Gerente e administrador enxergam e editam tudo. O cargo "Analista de Documentação" enxerga e edita só essa aba (não vê Financeiro, Contratos, Relatórios nem Auditoria). Cada corretor vê, sem poder editar, apenas os processos ligados aos clientes que ele atende. Um processo parado tempo demais numa etapa aparece com selo vermelho "parado há X dias".' },
  { titulo: 'Como cadastro as correspondentes bancárias, loteadoras e cartórios?', texto: 'Na aba Aprovações, botão "Instituições" (gerente/admin/analista). Cadastre o nome e o tipo; depois é só escolher a instituição no processo. Só o gerente pode excluir.' },
];

function carregarTutorial() {
  $('#tutorialContent').innerHTML = TUTORIAL_TOPICOS.map((t) => `
    <details>
      <summary>${t.titulo}</summary>
      <p>${t.texto}</p>
    </details>
  `).join('');
}

// =====================================================================
// MINI BOT DE AJUDA (todos têm acesso) — respostas por palavra-chave
// =====================================================================
function semAcento(txt) {
  return (txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Busca "por palavras": cada palavra digitada precisa aparecer em algum lugar do texto,
// em qualquer ordem — em vez de exigir a frase inteira igualzinha e na sequência.
// Ex: buscar "hauer 2 dormitorios" bate com "Hauer 4You — 2 Dormitórios...".
function bateBuscaPorPalavras(termoBusca, textoAlvo) {
  const alvo = semAcento(textoAlvo);
  const palavras = semAcento(termoBusca).split(/\s+/).filter(Boolean);
  return palavras.every((p) => alvo.includes(p));
}

// Coloca <mark> em volta de cada palavra buscada que aparecer no texto (ignorando acentos/maiúsculas),
// mantendo a grafia original do texto. Calcula as posições batendo no texto "normalizado" (sem
// acento) e depois recorta o texto ORIGINAL nessas mesmas posições — evita marcar duas vezes
// ou marcar dentro de uma tag já inserida (o que quebraria o HTML).
function destacarBusca(termoBusca, texto) {
  if (!termoBusca || !texto) return texto;
  const palavras = semAcento(termoBusca).split(/\s+/).filter(Boolean);
  if (!palavras.length) return texto;
  const alvo = semAcento(texto); // mesmo tamanho de `texto` (só troca acento por letra base)

  const faixas = [];
  palavras.forEach((p) => {
    let pos = 0;
    while (true) {
      const i = alvo.indexOf(p, pos);
      if (i === -1) break;
      faixas.push([i, i + p.length]);
      pos = i + p.length;
    }
  });
  if (!faixas.length) return texto;

  faixas.sort((a, b) => a[0] - b[0]);
  const mescladas = [faixas[0]];
  faixas.slice(1).forEach(([ini, fim]) => {
    const ultima = mescladas[mescladas.length - 1];
    if (ini <= ultima[1]) ultima[1] = Math.max(ultima[1], fim);
    else mescladas.push([ini, fim]);
  });

  let resultado = '';
  let cursor = 0;
  mescladas.forEach(([ini, fim]) => {
    resultado += texto.slice(cursor, ini);
    resultado += `<mark class="busca-destaque">${texto.slice(ini, fim)}</mark>`;
    cursor = fim;
  });
  resultado += texto.slice(cursor);
  return resultado;
}

const BOT_FAQ = [
  { gatilhos: ['login', 'entrar', 'acessar', 'senha'], contexto: ['esqueci', 'nao consigo', 'como'], resposta: 'Use seu e-mail e senha cadastrados na tela inicial. Esqueceu a senha? Clique em "Esqueci minha senha" e siga o link enviado por e-mail.' },
  { gatilhos: ['dashboard', 'painel', 'inicial'], contexto: ['que e', 'o que', 'pra que serve'], resposta: 'O Dashboard é a tela inicial: mostra leads novos, imóveis disponíveis, visitas agendadas e os últimos leads recebidos.' },
  { gatilhos: ['lead', 'leads'], contexto: ['status', 'funil', 'atendimento', 'mudar', 'avancar'], resposta: 'Na tela Leads, você filtra por status e muda o status de cada lead direto na lista, seguindo o funil: novo → tentativas de contato (1ª/2ª/3ª) → busca qualificada → visita agendada → visita feita → alterar busca → proposta → documentação → assinaturas → pós-venda (30/60/90/120 dias), ou lead frio perdido.' },
  { gatilhos: ['funil', 'kanban', 'dastbord', 'dashboard individual'], contexto: ['vend', 'lead', 'corretor', 'acompanh'], resposta: 'O Funil de Vendas é um quadro com colunas por etapa do lead. Cada corretor vê só os próprios leads; gerente e admin veem e editam os de todos, com filtro por corretor.' },
  { gatilhos: ['cadastr', 'novo imovel', 'imovel novo', 'criar imovel'], contexto: ['imovel', 'casa', 'apartamento', 'terreno'], resposta: 'Vá em Imóveis → "+ Novo imóvel", preencha os dados, envie as fotos e escolha o corretor responsável. Clique na estrela da foto para defini-la como capa.' },
  { gatilhos: ['capa', 'foto principal', 'estrela'], contexto: ['foto', 'imagem', 'imovel'], resposta: 'No formulário do imóvel, clique na estrelinha da miniatura da foto que quer usar como principal — ela fica marcada em dourado.' },
  { gatilhos: ['video', 'youtube'], contexto: ['imovel', 'link', 'colar'], resposta: 'No formulário do imóvel tem um campo "Vídeo (link do YouTube)" — é só colar o link completo lá.' },
  { gatilhos: ['corretor responsavel', 'trocar corretor', 'mudar corretor'], contexto: ['imovel', 'quem pode', 'alterar'], resposta: 'Qualquer corretor edita o imóvel normalmente, mas só gerente e administrador podem trocar o corretor responsável.' },
  { gatilhos: ['pessoa', 'proprietario', 'comprador', 'locatario', 'inquilino', 'vendedor', 'locador'], contexto: ['cadastr', 'novo', 'duplicad'], resposta: 'Vá em Pessoas → "+ Nova pessoa", preencha os dados e marque os papéis (proprietário, inquilino, comprador, vendedor, locador, construtor, incorporadora). O sistema bloqueia duplicidade por telefone, e-mail ou CPF/CNPJ.' },
  { gatilhos: ['visita', 'agendar visita'], contexto: ['marcar', 'como', 'cancelar'], resposta: 'Em Visitas → "+ Agendar visita", escolha imóvel, lead e data/horário. Para cancelar, use o botão "Cancelar" na lista.' },
  { gatilhos: ['contrato', 'financeiro', 'cobranca', 'aluguel'], contexto: ['como', 'ver', 'multa', 'juros'], resposta: 'Financeiro mostra as cobranças de aluguel. A multa e os juros por atraso não entram sozinhos — na cobrança atrasada tem o botão "Cobrar multa/juros" para você decidir. Essas telas são só para gerente/admin.' },
  { gatilhos: ['relatorio', 'baixar relatorio', 'exportar', 'csv'], contexto: ['financeiro', 'pessoas', 'proprietario', 'como'], resposta: 'Em Relatórios (só gerente/admin), clique no card do relatório desejado para baixar o CSV — financeiro, pessoas, proprietários, locadores, locatários, compradores, vendedores, construtores ou construtoras.' },
  { gatilhos: ['backup', 'locaticia', 'gestao locaticia'], contexto: ['como', 'baixar', 'exportar'], resposta: 'Em Relatórios, clique no card "Backup — Gestão Locatícia" (só gerente/admin) para baixar um JSON com contratos de locação e cobranças.' },
  { gatilhos: ['excluir', 'apagar', 'deletar', 'remover'], contexto: ['quem pode', 'imovel', 'pessoa', 'cadastro', 'nao consigo'], resposta: 'Somente quem é gerente pode excluir qualquer cadastro (imóveis, pessoas, equipe, depoimentos, fotos do site). Administrador e corretores podem criar e editar, mas não excluir.' },
  { gatilhos: ['conteudo do site', 'sobre nos', 'rodape', 'redes sociais'], contexto: ['editar', 'mudar', 'texto'], resposta: 'Em "Conteúdo do Site" (só gerente/admin), edite o texto do Sobre Nós, da página de anúncio de imóvel, o rodapé e os links das redes sociais.' },
  { gatilhos: ['fotos do site', 'hero', 'home'], contexto: ['adicionar', 'trocar', 'girar'], resposta: 'Em "Fotos do Site" → "+ Nova foto", envie a imagem e ative/desative quais aparecem na home com o botão "Ativa no site".' },
  { gatilhos: ['depoimento', 'avaliacao'], contexto: ['cadastr', 'cliente', 'nota'], resposta: 'Em Depoimentos → "+ Novo depoimento", preencha nome do cliente, texto e nota de 1 a 5, e marque se ele aparece no site.' },
  { gatilhos: ['novo lead', 'cadastrar lead', 'lead manual'], contexto: ['telefone', 'balcao', 'ligou', 'como'], resposta: 'Em Leads → "+ Novo lead". Se deixar o corretor em branco, o sistema distribui automaticamente para quem está com menos leads no mês.' },
  { gatilhos: ['motivo da perda', 'motivo perdido', 'perdido'], contexto: ['lead', 'por que', 'negocio'], resposta: 'Quando você muda o status do lead para "perdido", o sistema pergunta o motivo (preço, financiamento, concorrente etc.) e guarda essa informação.' },
  { gatilhos: ['historico', 'interacao', 'conversa'], contexto: ['lead', 'anotacao', 'ligacao'], resposta: 'Clique em "Ver" no lead — lá tem o histórico completo de interações e um campo pra adicionar nova anotação.' },
  { gatilhos: ['comissao'], contexto: ['corretor', 'contrato', 'lancar', 'quanto'], resposta: 'No formulário de Contrato, preencha o percentual de comissão — o valor em reais é calculado automaticamente.' },
  { gatilhos: ['repasse'], contexto: ['proprietario', 'aluguel', 'quanto', 'financeiro'], resposta: 'Em Financeiro, logo abaixo das cobranças, tem a tabela de repasse ao proprietário, já calculada descontando a taxa de administração.' },
  { gatilhos: ['ranking', 'meta'], contexto: ['corretor', 'dashboard', 'desempenho'], resposta: 'No Dashboard (gerente/admin) tem o ranking de corretores — negócios fechados, comissão gerada e % da meta cadastrada em Equipe.' },
  { gatilhos: ['vistoria'], contexto: ['entrada', 'saida', 'checklist', 'imovel'], resposta: 'Em Vistorias → "+ Nova vistoria", escolha o imóvel e o tipo. Depois clique em "Abrir" para o checklist, fotos e laudo final.' },
  { gatilhos: ['assinatura', 'assinar laudo', 'laudo pdf'], contexto: ['vistoria', 'locatario', 'baixar'], resposta: 'Dentro da vistoria, clique em "Baixar laudo (PDF) para assinatura" — o PDF já vem com linhas de assinatura para o locatário e para a imobiliária.' },
  { gatilhos: ['documento', 'anexo', 'matricula', 'rg'], contexto: ['pessoa', 'imovel', 'anexar'], resposta: 'Ao editar uma pessoa ou imóvel já cadastrado, aparece a seção "Documentos anexados" para enviar e baixar arquivos.' },
  { gatilhos: ['ficha pdf', 'ficha do imovel', 'pdf'], contexto: ['imovel', 'baixar', 'gerar'], resposta: 'Na tela Imóveis, clique em "Ficha PDF" na linha do imóvel — gera um PDF pronto pra enviar ao cliente.' },
  { gatilhos: ['auditoria'], contexto: ['quem alterou', 'log', 'historico de alteracao'], resposta: 'A aba Auditoria (gerente/admin) mostra quem criou, editou ou excluiu qualquer imóvel, pessoa, contrato ou integrante da equipe.' },
  { gatilhos: ['portal do proprietario', 'portal proprietario'], contexto: ['acesso', 'liberar', 'login'], resposta: 'Crie o login do proprietário em Supabase → Authentication → Users com o mesmo e-mail cadastrado, copie o UID e cole em Pessoas, no campo "ID de acesso ao Portal".' },
];

function pontuarFaq(pergunta) {
  const texto = semAcento(pergunta);
  let melhor = null;
  let melhorPontos = 0;
  for (const item of BOT_FAQ) {
    let pontos = 0;
    for (const g of item.gatilhos) if (texto.includes(semAcento(g))) pontos += 2;
    for (const c of item.contexto) if (texto.includes(semAcento(c))) pontos += 1;
    if (pontos > melhorPontos) { melhorPontos = pontos; melhor = item; }
  }
  return melhorPontos >= 2 ? melhor : null;
}

function adicionarMensagemBot(texto, autor) {
  const wrap = document.createElement('div');
  wrap.className = `bot-msg ${autor}`;
  wrap.textContent = texto;
  $('#botMessages').appendChild(wrap);
  $('#botMessages').scrollTop = $('#botMessages').scrollHeight;
}

function responderBot(pergunta) {
  const item = pontuarFaq(pergunta);
  adicionarMensagemBot(
    item ? item.resposta : 'Não encontrei uma resposta certeira pra isso. Dá uma olhada na aba Tutorial ou tenta perguntar de outro jeito — por exemplo "como cadastro um imóvel" ou "quem pode excluir".',
    'bot'
  );
}

$('#botToggle').addEventListener('click', () => {
  const painel = $('#botPanel');
  painel.hidden = !painel.hidden;
  if (!painel.hidden && !$('#botMessages').childElementCount) {
    adicionarMensagemBot('Oi! Sou o assistente do CRM. Pergunte algo como "como cadastro um imóvel" ou "quem pode excluir".', 'bot');
  }
});
$('#botClose').addEventListener('click', () => { $('#botPanel').hidden = true; });

$('#botForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#botInput');
  const pergunta = input.value.trim();
  if (!pergunta) return;
  adicionarMensagemBot(pergunta, 'user');
  input.value = '';
  responderBot(pergunta);
});


// =====================================================================
// GERADOR DE DOCUMENTOS (contratos, fichas e termos em .docx)
// =====================================================================
let configSiteDocCache = null;

const CAMPOS_PESSOA_DOC = [
  ['nome', 'Nome completo', true],
  ['nacionalidade', 'Nacionalidade'],
  ['estado_civil', 'Estado civil'],
  ['profissao', 'Profissão'],
  ['rg', 'RG'],
  ['cpf', 'CPF'],
  ['telefone', 'Telefone'],
  ['email', 'E-mail'],
  ['endereco', 'Endereço completo', false, true],
];

// ---------- helpers de valores (usados no cálculo da prestação de contas) ----------
// Converte string em formato BR ("1.234,56") para número. Tolerante a
// valores já numéricos, vazios ou mal formatados (retorna 0 nesse caso).
function parseValorBR(str) {
  if (str === undefined || str === null || str === '') return 0;
  const limpo = String(str).trim().replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return Number.isFinite(n) ? n : 0;
}

function formatValorBR(n) {
  return (Number.isFinite(n) ? n : 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Lê um campo textarea de lançamentos (uma linha por item, colunas separadas
// por "|") e retorna a soma da coluna de valor (índice 1, sempre a 2ª coluna).
function somarLancamentosTextarea(texto) {
  return (texto || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .reduce((soma, linha) => soma + parseValorBR(linha.split('|')[1] || ''), 0);
}

// Padroniza a coluna de VALOR (índice 1) de um textarea de lançamentos:
// tira "R$", espaços extras e deixa tudo no formato 1.234,56. As demais
// colunas (descrição, parcela) ficam iguais.
function normalizarColunaValorTextarea(texto) {
  return (texto || '').split('\n').map((l) => l.trim()).filter(Boolean).map((linha) => {
    const cols = linha.split('|').map((c) => c.trim());
    if (cols.length >= 2 && cols[1] !== '') cols[1] = formatValorBR(parseValorBR(cols[1]));
    return cols.join(' | ');
  }).join('\n');
}

const MODELOS_DOC = [
  {
    id: 'locacao',
    arquivo: 'contrato_locacao_residencial.docx',
    titulo: 'Contrato de Locação Residencial',
    descricao: 'Modelo próprio Gregório | Meu Lar (28 cláusulas): locador, até 2 locatários, imóvel, valores, atraso, vistoria, benfeitorias, seguro-incêndio, multa rescisória e caução.',
    pessoas: [
      { prefixo: 'locador', rotulo: 'Locador(a) — proprietário(a)' },
      { prefixo: 'locatario', rotulo: 'Locatário(a) 1' },
      { prefixo: 'locatario2', rotulo: 'Locatário(a) 2 (opcional — cônjuge/coinquilino)', obrigatorio: false },
      { prefixo: 'locatario3', rotulo: 'Locatário(a) 3 (opcional — cônjuge/coinquilino)', obrigatorio: false },
    ],
    imovel: true,
    nomeArquivoTag: 'locatario_nome',
    paresValorExtenso: [['valor_aluguel', 'valor_aluguel_extenso'], ['valor_caucao', 'valor_caucao_extenso']],
    computar(dados) {
      dados.tem_locatario2 = !!(dados.locatario2_nome && dados.locatario2_nome.trim());
      dados.tem_locatario3 = !!(dados.locatario3_nome && dados.locatario3_nome.trim());
      // A data de término é SEMPRE calculada a partir de início + prazo em meses —
      // nunca deixada pro corretor digitar separadamente. Isso evita contratos com
      // texto ("prazo de X meses") contradizendo as datas impressas, como já aconteceu.
      if (dados.data_inicio && dados.prazo_meses) {
        const [ano, mes, dia] = dados.data_inicio.split('-').map(Number);
        const termino = new Date(ano, (mes - 1) + parseInt(dados.prazo_meses, 10), dia);
        dados.data_termino = `${termino.getFullYear()}-${String(termino.getMonth() + 1).padStart(2, '0')}-${String(termino.getDate()).padStart(2, '0')}`;
      }
    },
    campos: [
      { tag: 'imovel_comodos_descricao', rotulo: 'Imóvel — cômodos e descrição complementar', tipo: 'textarea', full: true, placeholder: 'Ex.: sobrado com garagem coberta para 1 veículo, cozinha, sala, 2 dormitórios e 2 banheiros' },
      { tag: 'imovel_matriculas_concessionarias', rotulo: 'Imóvel — matrículas de concessionárias (Sanepar/Copel etc., opcional)', full: true, placeholder: 'Ex.: Matrícula Sanepar nº 34623783 — Unidade Copel nº 100203167.' },
      { tag: 'valor_aluguel', rotulo: 'Valor do aluguel (R$)', placeholder: 'Ex: 1.800,00' },
      { tag: 'valor_aluguel_extenso', rotulo: 'Valor do aluguel por extenso (sugestão automática)', full: true },
      { tag: 'dia_vencimento', rotulo: 'Dia de vencimento', tipo: 'number', default: '5' },
      { tag: 'prazo_meses', rotulo: 'Prazo da locação (meses) — padrão 12; só mude se o combinado for outro prazo', tipo: 'number', default: '12' },
      { tag: 'data_inicio', rotulo: 'Data de início', tipo: 'date' },
      { tag: 'data_termino', rotulo: 'Data de término (calculada automaticamente = início + prazo em meses; não precisa preencher)', tipo: 'date' },
      { tag: 'mes_resilicao_sem_multa', rotulo: 'Rescisão sem multa a partir do mês', tipo: 'number', default: '13' },
      { tag: 'indice_reajuste', rotulo: 'Índice de reajuste anual', full: true, default: 'IGP-M/FGV, ou, na impossibilidade de utilização deste índice, o IPCA' },
      { tag: 'taxa_segunda_via_boleto', rotulo: 'Taxa de 2ª via do boleto', default: 'R$ 10,00' },
      { tag: 'multa_atraso_percentual', rotulo: 'Multa por atraso no aluguel (%)', tipo: 'number', default: '2' },
      { tag: 'juros_mora_percentual', rotulo: 'Juros de mora ao mês (%)', tipo: 'number', default: '1' },
      { tag: 'honorarios_extrajudicial_percentual', rotulo: 'Honorários de cobrança extrajudicial (%)', tipo: 'number', default: '10' },
      { tag: 'honorarios_judiciais_percentual', rotulo: 'Honorários de cobrança judicial (%)', tipo: 'number', default: '20' },
      { tag: 'prazo_cobranca_honorarios_dias', rotulo: 'Prazo p/ incidência de honorários de cobrança (dias)', tipo: 'number', default: '60' },
      { tag: 'prazo_contestacao_vistoria_dias', rotulo: 'Prazo p/ contestar vistoria de entrada (dias)', tipo: 'number', default: '7' },
      { tag: 'taxa_vistoria_valor', rotulo: 'Taxa de vistoria (entrada e saída)', default: 'R$ 100,00' },
      { tag: 'despesas_ordinarias_locatario', rotulo: 'Despesas ordinárias por conta do locatário', full: true, default: 'água/Sanepar, energia elétrica/Copel, gás e internet' },
      { tag: 'condominio_observacao', rotulo: 'Condomínio', tipo: 'select', full: true, opcoes: [
        'Não há condomínio incidente sobre o imóvel.',
        'O valor do condomínio já está incluso no aluguel mensal e é de responsabilidade do LOCADOR.',
        'O condomínio não está incluso no aluguel e é de responsabilidade do LOCATÁRIO, pago diretamente à administradora do condomínio.',
      ] },
      { tag: 'prazo_transferencia_titularidade_dias', rotulo: 'Prazo p/ transferir titularidade luz/água/gás (dias)', tipo: 'number', default: '14' },
      { tag: 'multa_transferencia_titularidade_percentual', rotulo: 'Multa por não transferir titularidade (% do aluguel)', tipo: 'number', default: '10' },
      { tag: 'prazo_seguro_incendio_horas', rotulo: 'Prazo p/ contratar seguro-incêndio (horas)', tipo: 'number', default: '72' },
      { tag: 'benfeitorias_necessarias_locatario', rotulo: 'Benfeitorias necessárias a cargo do locatário', tipo: 'textarea', full: true, default: 'conforme condições descritas no Laudo de Vistoria de Entrada' },
      { tag: 'multa_rescisao_meses', rotulo: 'Multa de rescisão antecipada (meses de aluguel)', tipo: 'number', default: '3' },
      { tag: 'prazo_aviso_rescisao_dias', rotulo: 'Prazo de aviso prévio p/ rescisão (dias)', tipo: 'number', default: '30' },
      { tag: 'meses_isencao_multa_rescisao', rotulo: 'Meses com isenção de multa rescisória', default: '12º e 24º' },
      { tag: 'valor_caucao', rotulo: 'Valor da caução (R$)', placeholder: 'Ex: 1.800,00' },
      { tag: 'valor_caucao_extenso', rotulo: 'Valor da caução por extenso (sugestão automática)', full: true },
      { tag: 'forma_pagamento_caucao', rotulo: 'Forma de pagamento da caução', full: true, default: 'à vista, via PIX ou cartão de crédito, em conta indicada pela ADMINISTRADORA' },
      { tag: 'data_pagamento_caucao', rotulo: 'Data de pagamento da caução', tipo: 'date' },
      { tag: 'prazo_devolucao_caucao_dias', rotulo: 'Prazo de devolução da caução (dias úteis)', tipo: 'number', default: '30' },
      { tag: 'testemunha1_nome', rotulo: 'Testemunha 1 — nome' },
      { tag: 'testemunha1_cpf', rotulo: 'Testemunha 1 — CPF' },
      { tag: 'testemunha2_nome', rotulo: 'Testemunha 2 — nome' },
      { tag: 'testemunha2_cpf', rotulo: 'Testemunha 2 — CPF' },
    ],
  },
  {
    id: 'locacao_comercial',
    arquivo: 'contrato_locacao_comercial.docx',
    titulo: 'Contrato de Locação Comercial',
    descricao: 'Modelo próprio Gregório | Meu Lar (21 cláusulas): locador, até 2 locatários, imóvel, valores, atraso, vistoria, seguro, caução, direito de preferência e utilização comercial.',
    pessoas: [
      { prefixo: 'locador', rotulo: 'Locador(a) — proprietário(a)' },
      { prefixo: 'locatario', rotulo: 'Locatário(a) 1' },
      { prefixo: 'locatario2', rotulo: 'Locatário(a) 2 (opcional — sócio/cônjuge)', obrigatorio: false },
    ],
    imovel: true,
    nomeArquivoTag: 'locatario_nome',
    paresValorExtenso: [['valor_aluguel', 'valor_aluguel_extenso'], ['valor_caucao', 'valor_caucao_extenso']],
    computar(dados) { dados.tem_locatario2 = !!(dados.locatario2_nome && dados.locatario2_nome.trim());
      // Mesma correção do modelo residencial: data de término sempre calculada
      // a partir de início + prazo em meses, nunca digitada à parte.
      if (dados.data_inicio && dados.prazo_meses) {
        const [ano, mes, dia] = dados.data_inicio.split('-').map(Number);
        const termino = new Date(ano, (mes - 1) + parseInt(dados.prazo_meses, 10), dia);
        dados.data_termino = `${termino.getFullYear()}-${String(termino.getMonth() + 1).padStart(2, '0')}-${String(termino.getDate()).padStart(2, '0')}`;
      }
    },
    campos: [
      { tag: 'imovel_dimensoes', rotulo: 'Imóvel — dimensões (frente x fundo)', placeholder: 'Ex: 14m de frente por 28,38m de fundo' },
      { tag: 'imovel_inscricao_fiscal', rotulo: 'Imóvel — inscrição fiscal', placeholder: 'Ex: 81.892.003.000-5' },
      { tag: 'ramo_atividade', rotulo: 'Ramo de atividade do(a) locatário(a)', full: true, placeholder: 'Ex: comércio varejista de roupas' },
      { tag: 'valor_aluguel', rotulo: 'Valor do aluguel (R$)', placeholder: 'Ex: 3.210,00' },
      { tag: 'valor_aluguel_extenso', rotulo: 'Valor do aluguel por extenso (sugestão automática)', full: true },
      { tag: 'dia_vencimento', rotulo: 'Dia de vencimento', tipo: 'number', default: '5' },
      { tag: 'prazo_meses', rotulo: 'Prazo da locação (meses)', tipo: 'number', default: '36' },
      { tag: 'data_inicio', rotulo: 'Data de início', tipo: 'date' },
      { tag: 'data_termino', rotulo: 'Data de término (calculada automaticamente = início + prazo em meses; não precisa preencher)', tipo: 'date' },
      { tag: 'mes_resilicao_sem_multa', rotulo: 'Rescisão sem multa após pagos (meses de aluguel)', tipo: 'number', default: '12' },
      { tag: 'prazo_aviso_desocupacao_dias', rotulo: 'Prazo p/ desocupar após rescisão sem multa (dias)', tipo: 'number', default: '30' },
      { tag: 'renovacao_automatica_anos', rotulo: 'Renovação automática (anos)', tipo: 'number', default: '1' },
      { tag: 'dias_antecedencia_boleto', rotulo: 'Envio do boleto com antecedência de (dias)', tipo: 'number', default: '2' },
      { tag: 'taxa_emissao_boleto', rotulo: 'Taxa de emissão do boleto', default: 'R$ 2,50' },
      { tag: 'indice_reajuste', rotulo: 'Índice de reajuste anual', default: 'IPCA' },
      { tag: 'reajuste_piso_percentual', rotulo: 'Reajuste mínimo se índice for negativo (%)', tipo: 'number', default: '5' },
      { tag: 'multa_atraso_percentual', rotulo: 'Multa por atraso no aluguel (%)', tipo: 'number', default: '2' },
      { tag: 'juros_mora_percentual', rotulo: 'Juros de mora ao mês (%)', tipo: 'number', default: '1' },
      { tag: 'honorarios_atraso_percentual', rotulo: 'Honorários advocatícios sobre débito (%)', tipo: 'number', default: '20' },
      { tag: 'prazo_honorarios_dias', rotulo: 'Prazo p/ incidência de honorários (dias)', tipo: 'number', default: '60' },
      { tag: 'prazo_contestacao_vistoria_dias', rotulo: 'Prazo p/ contestar vistoria de entrada (dias)', tipo: 'number', default: '7' },
      { tag: 'taxa_vistoria_valor', rotulo: 'Taxa de vistoria (entrada e saída)', default: 'R$ 100,00' },
      { tag: 'despesas_ordinarias_locatario', rotulo: 'Despesas ordinárias por conta do locatário', full: true, default: 'água/Sanepar (100%), energia elétrica/Copel (100%), gás e taxa de lixo/limpeza' },
      { tag: 'consequencia_nao_transferencia', rotulo: 'Consequência se não transferir titularidade em 14 dias', full: true, default: 'Em caso de não alteração da titularidade no prazo de 14 (quatorze) dias, a ADMINISTRADORA poderá desligar o fornecimento de energia, água e gás no imóvel.' },
      { tag: 'multa_rescisao_meses', rotulo: 'Multa de rescisão antecipada (meses de aluguel)', tipo: 'number', default: '3' },
      { tag: 'prazo_aviso_rescisao_dias', rotulo: 'Prazo de aviso prévio p/ rescisão (dias)', tipo: 'number', default: '30' },
      { tag: 'mes_isencao_multa_rescisao', rotulo: 'Isenção de multa rescisória após o mês', default: '12º' },
      { tag: 'prazo_direito_preferencia_dias', rotulo: 'Prazo p/ manifestar direito de preferência na venda (dias)', tipo: 'number', default: '30' },
      { tag: 'prazo_desocupacao_pos_venda_dias', rotulo: 'Prazo de desocupação se vendido a terceiro (dias)', tipo: 'number', default: '90' },
      { tag: 'valor_caucao', rotulo: 'Valor da caução (R$)', placeholder: 'Ex: 3.210,00' },
      { tag: 'valor_caucao_extenso', rotulo: 'Valor da caução por extenso (sugestão automática)', full: true },
      { tag: 'forma_pagamento_caucao', rotulo: 'Forma de pagamento da caução', full: true, default: 'via PIX, em conta indicada pela ADMINISTRADORA' },
      { tag: 'indice_correcao_caucao', rotulo: 'Índice de correção da caução na devolução', default: 'IPCA' },
      { tag: 'multa_comunicacao_meses', rotulo: 'Multa por não comunicar via administradora (x aluguel)', tipo: 'number', default: '3' },
      { tag: 'testemunha1_nome', rotulo: 'Testemunha 1 — nome' },
      { tag: 'testemunha1_cpf', rotulo: 'Testemunha 1 — CPF' },
      { tag: 'testemunha2_nome', rotulo: 'Testemunha 2 — nome' },
      { tag: 'testemunha2_cpf', rotulo: 'Testemunha 2 — CPF' },
    ],
  },
  {
    id: 'compra_venda',
    arquivo: 'contrato_compra_venda.docx',
    titulo: 'Contrato de Compra e Venda',
    descricao: 'Modelo próprio Gregório | Meu Lar: vendedor(a), até 2 compradores, imóvel, valor, arras, despesas de transferência e comissão.',
    pessoas: [
      { prefixo: 'vendedor', rotulo: 'Vendedor(a)' },
      { prefixo: 'comprador', rotulo: 'Comprador(a) 1' },
      { prefixo: 'comprador2', rotulo: 'Comprador(a) 2 (opcional — cônjuge/coproprietário)', obrigatorio: false },
    ],
    imovel: true,
    nomeArquivoTag: 'comprador_nome',
    paresValorExtenso: [['valor_venda', 'valor_venda_extenso']],
    computar(dados) { dados.tem_comprador2 = !!(dados.comprador2_nome && dados.comprador2_nome.trim()); },
    campos: [
      { tag: 'imovel_descricao_detalhada', rotulo: 'Imóvel — descrição detalhada', tipo: 'textarea', full: true, placeholder: 'Ex: casa com 2 dormitórios, sendo 1 suíte, 2 banheiros, 2 vagas de garagem' },
      { tag: 'valor_venda', rotulo: 'Valor da venda (R$)', placeholder: 'Ex: 270.000,00' },
      { tag: 'valor_venda_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'condicoes_pagamento', rotulo: 'Condições de pagamento (detalhado)', tipo: 'textarea', full: true, placeholder: 'Ex: R$ 253.800,00 em recursos próprios após transferência de escritura; R$ 10.000,00 de sinal de negócio via PIX; R$ 6.200,00 em recursos próprios' },
      { tag: 'prazo_documentos_dias', rotulo: 'Prazo p/ apresentar documentos após aceite (dias)', tipo: 'number', default: '15' },
      { tag: 'situacao_iptu', rotulo: 'Situação do IPTU', full: true, default: 'O(A) VENDEDOR(A) declara que o imóvel se encontra sem dívidas de IPTU.' },
      { tag: 'prazo_chaves_pos_escritura_dias', rotulo: 'Prazo p/ entrega definitiva das chaves após escritura (dias)', tipo: 'number', default: '5' },
      { tag: 'prazo_pagamento_final_dias', rotulo: 'Prazo p/ pagamento final após assinatura da escritura (dias)', tipo: 'number', default: '1' },
      { tag: 'valor_comissao', rotulo: 'Valor da comissão imobiliária (R$)', placeholder: 'Ex: 16.200,00' },
      { tag: 'honorarios_foro_percentual', rotulo: 'Honorários advocatícios em caso de demanda judicial (%)', tipo: 'number', default: '10' },
      { tag: 'testemunha1_nome', rotulo: 'Testemunha 1 — nome' },
      { tag: 'testemunha1_cpf', rotulo: 'Testemunha 1 — CPF' },
      { tag: 'testemunha2_nome', rotulo: 'Testemunha 2 — nome' },
      { tag: 'testemunha2_cpf', rotulo: 'Testemunha 2 — CPF' },
    ],
  },
  {
    id: 'proposta_compra',
    arquivo: 'proposta_compra_sinal_reserva.docx',
    titulo: 'Proposta de Compra com Sinal de Reserva',
    descricao: 'Modelo próprio Gregório | Meu Lar: quadro-resumo do proponente, valor da proposta, sinal de negócio e cláusulas de arras (Art. 420 CC).',
    pessoas: [
      { prefixo: 'proponente', rotulo: 'Proponente (comprador(a))' },
      { prefixo: 'vendedor', rotulo: 'Vendedor(a)/Proprietário(a)' },
    ],
    imovel: true,
    nomeArquivoTag: 'proponente_nome',
    paresValorExtenso: [['valor_proposta', 'valor_proposta_extenso']],
    campos: [
      { tag: 'observacoes_gerais_venda', rotulo: 'Observações gerais da venda', tipo: 'textarea', full: true, placeholder: 'Ex: sinal de negócio no valor de 38.000,00 em 5x de R$ 7.600,00, saldo parcelado em 180x' },
      { tag: 'valor_proposta', rotulo: 'Valor da proposta (R$)', placeholder: 'Ex: 380.000,00' },
      { tag: 'valor_proposta_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'valor_sinal', rotulo: 'Valor do sinal de negócio (R$)' },
      { tag: 'percentual_sinal', rotulo: 'Sinal — percentual do valor da proposta (%)', tipo: 'number', default: '10' },
      { tag: 'responsavel_documentacao', rotulo: 'Documentação a ser paga por', tipo: 'select', opcoes: ['proprietário(a)', 'comprador(a)'] },
      { tag: 'renda_comprovada', rotulo: 'Renda comprovada', tipo: 'textarea', full: true, default: 'Não se aplica renda comprovada a este negócio.' },
      { tag: 'testemunha1_nome', rotulo: 'Testemunha 1 — nome' },
      { tag: 'testemunha1_cpf', rotulo: 'Testemunha 1 — CPF' },
      { tag: 'testemunha2_nome', rotulo: 'Testemunha 2 — nome' },
      { tag: 'testemunha2_cpf', rotulo: 'Testemunha 2 — CPF' },
    ],
  },
  {
    id: 'proposta_compra_planta',
    arquivo: null,
    titulo: 'Proposta de Compra com Sinal de Reserva — Imóvel na Planta',
    descricao: 'Modelo próprio Gregório | Meu Lar para unidade em empreendimento na planta: qualificação da incorporadora/construtora, dados do empreendimento e da unidade, previsão de entrega e correção do saldo durante a obra (Lei 4.591/64).',
    pessoas: [{ prefixo: 'proponente', rotulo: 'Proponente (comprador(a))' }],
    empresaConstrutora: true,
    rotuloConstrutora: 'Incorporadora/Construtora (Vendedora)',
    nomeArquivoTag: 'proponente_nome',
    paresValorExtenso: [['valor_proposta', 'valor_proposta_extenso']],
    campos: [
      { tag: 'nome_empreendimento', rotulo: 'Nome do empreendimento', placeholder: 'Ex: Residencial Veneza Solar' },
      { tag: 'endereco_empreendimento', rotulo: 'Endereço do empreendimento', full: true },
      { tag: 'registro_incorporacao', rotulo: 'Registro de incorporação (nº e Cartório de Registro de Imóveis)', full: true, placeholder: 'Ex: R-1, matrícula 12.345, 2º Ofício de Registro de Imóveis de Curitiba' },
      { tag: 'numero_unidade', rotulo: 'Número da unidade' },
      { tag: 'bloco_torre_pavimento', rotulo: 'Bloco/torre/pavimento (opcional)', placeholder: 'Ex: Torre 2, 5º pavimento' },
      { tag: 'area_privativa_m2', rotulo: 'Área privativa aproximada (m²)' },
      { tag: 'vaga_garagem', rotulo: 'Vaga(s) de garagem', placeholder: 'Ex: 1 (uma) vaga de garagem' },
      { tag: 'previsao_entrega', rotulo: 'Previsão de entrega', placeholder: 'Ex: dezembro de 2028' },
      { tag: 'prazo_tolerancia_dias', rotulo: 'Prazo de tolerância na entrega (dias)', tipo: 'number', default: '180' },
      { tag: 'indice_correcao_saldo_obra', rotulo: 'Índice de correção do saldo durante a obra', default: 'INCC-DI' },
      { tag: 'indice_correcao_saldo_pos_entrega', rotulo: 'Índice de correção do saldo após entrega/habite-se', default: 'IGP-M' },
      { tag: 'observacoes_gerais_venda', rotulo: 'Observações gerais da venda', tipo: 'textarea', full: true },
      { tag: 'valor_proposta', rotulo: 'Valor da proposta (R$)', placeholder: 'Ex: 380.000,00' },
      { tag: 'valor_proposta_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'valor_sinal', rotulo: 'Valor do sinal de negócio (R$)' },
      { tag: 'percentual_sinal', rotulo: 'Sinal — percentual do valor da proposta (%)', tipo: 'number', default: '10' },
      { tag: 'forma_pagamento_proposta', rotulo: 'Forma de pagamento (detalhado)', tipo: 'textarea', full: true, placeholder: 'Ex: sinal de R$ 38.000,00; entrada de R$ 42.000,00 em 10x; saldo de R$ 300.000,00 financiado na entrega das chaves' },
      { tag: 'responsavel_documentacao', rotulo: 'Documentação a ser paga por', tipo: 'select', opcoes: ['incorporadora/construtora', 'comprador(a)'] },
      { tag: 'prazo_aceite_dias', rotulo: 'Prazo de aceite da proposta (dias)', tipo: 'number', default: '5' },
      { tag: 'testemunha1_nome', rotulo: 'Testemunha 1 — nome' },
      { tag: 'testemunha1_cpf', rotulo: 'Testemunha 1 — CPF' },
      { tag: 'testemunha2_nome', rotulo: 'Testemunha 2 — nome' },
      { tag: 'testemunha2_cpf', rotulo: 'Testemunha 2 — CPF' },
    ],
  },
  {
    id: 'retirada_chaves',
    arquivo: 'termo_retirada_chaves.docx',
    titulo: 'Termo de Entrega de Chaves',
    descricao: 'Registro de quem retirou as chaves do imóvel, conformidade com a vistoria, finalidade, prazo de devolução e responsabilidade.',
    pessoas: [{ prefixo: 'recebedor', rotulo: 'Recebedor(a) das chaves' }],
    imovel: true,
    nomeArquivoTag: 'recebedor_nome',
    computar(dados) { dados.retirada_temporaria = (dados.tipo_retirada || '').startsWith('Temporária'); },
    campos: [
      { tag: 'imovel_comodos_descricao', rotulo: 'Imóvel — cômodos e descrição complementar', tipo: 'textarea', full: true, placeholder: 'Ex.: garagem descoberta para 1 veículo, cozinha, 2 dormitórios, sala e 1 banheiro' },
      { tag: 'imovel_matriculas_concessionarias', rotulo: 'Imóvel — matrículas de concessionárias (Sanepar/Copel etc., opcional)', full: true, placeholder: 'Ex.: Matrícula Sanepar nº 34873950.' },
      { tag: 'finalidade_retirada', rotulo: 'Finalidade', tipo: 'select', opcoes: ['locação', 'compra e venda', 'visita', 'vistoria', 'mudança', 'reforma/obras'] },
      { tag: 'tipo_retirada', rotulo: 'Modalidade', tipo: 'select', opcoes: ['Definitiva (entrega de posse)', 'Temporária (com compromisso de devolução)'], full: true },
      { tag: 'data_hora_retirada', rotulo: 'Data/hora da retirada', placeholder: 'Ex: 25/07/2026 às 14h' },
      { tag: 'data_prevista_devolucao', rotulo: 'Data prevista de devolução (se temporária)', tipo: 'date' },
      { tag: 'responsavel_entrega', rotulo: 'Entregue por (nome de quem entregou)' },
      { tag: 'estado_imovel_retirada', rotulo: 'Estado do imóvel no momento da retirada', tipo: 'textarea', full: true },
      { tag: 'observacoes_retirada', rotulo: 'Observações', tipo: 'textarea', full: true },
    ],
  },
  {
    id: 'ficha_visita_reserva',
    arquivo: 'ficha_visita_reserva_sinal.docx',
    titulo: 'Ficha de Visita com Sinal de Reserva',
    descricao: 'Registro da visita e reserva do imóvel mediante sinal, com prazo e condições de devolução.',
    pessoas: [{ prefixo: 'visitante', rotulo: 'Visitante' }],
    imovel: true,
    nomeArquivoTag: 'visitante_nome',
    paresValorExtenso: [['valor_sinal_reserva', 'valor_sinal_reserva_extenso']],
    campos: [
      { tag: 'data_hora_visita', rotulo: 'Data/hora da visita', placeholder: 'Ex: 25/07/2026 às 10h' },
      { tag: 'interesse_visita', rotulo: 'Interesse', tipo: 'select', opcoes: ['Compra', 'Locação'] },
      { tag: 'valor_sinal_reserva', rotulo: 'Valor do sinal de reserva (R$)' },
      { tag: 'valor_sinal_reserva_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'prazo_reserva_dias', rotulo: 'Prazo da reserva (dias)', tipo: 'number', default: '5' },
      { tag: 'observacoes_visita', rotulo: 'Observações', tipo: 'textarea', full: true },
    ],
  },
  {
    id: 'termo_autorizacao',
    arquivo: 'termo_autorizacao_venda_locacao.docx',
    titulo: 'Contrato de Intermediação e Autorização Venda Exclusividade',
    descricao: 'Modelo próprio Gregório | Meu Lar — somente VENDA, com EXCLUSIVIDADE: quadro-resumo do(s) proprietário(s), imóvel, vigência, publicidade e cláusulas completas de intermediação (arts. 722-729 CC).',
    pessoas: [
      { prefixo: 'proprietario', rotulo: 'Proprietário(a) 1' },
      { prefixo: 'proprietario2', rotulo: 'Proprietário(a) 2 (opcional — cônjuge/coproprietário)', obrigatorio: false },
    ],
    imovel: true,
    nomeArquivoTag: 'proprietario_nome',
    computar(dados) { dados.tem_proprietario2 = !!(dados.proprietario2_nome && dados.proprietario2_nome.trim()); },
    campos: [
      { tag: 'imovel_descricao_detalhada', rotulo: 'Imóvel — descrição detalhada', tipo: 'textarea', full: true, placeholder: 'Ex: sobrado com 2 dormitórios, sala, cozinha, banheiro' },
      { tag: 'data_inicio_autorizacao', rotulo: 'Início da vigência', tipo: 'date' },
      { tag: 'data_termino_autorizacao', rotulo: 'Término da vigência', tipo: 'date' },
      { tag: 'renovacao_automatica', rotulo: 'Renovação automática', tipo: 'select', opcoes: ['Sim', 'Não'] },
      { tag: 'tipos_publicidade_permitida', rotulo: 'Tipos de publicidade permitida', tipo: 'textarea', full: true, default: 'anúncios escritos físicos e eletrônicos; impulsionamento de visualização; folders; placas; cartazes; e correspondência física ou eletrônica (e-mail); outras' },
      { tag: 'documentos_apresentados', rotulo: 'Documentos apresentados pelo(a) contratante', default: 'documento do imóvel e documentos pessoais' },
      { tag: 'percentual_comissao_autorizacao', rotulo: 'Comissão de corretagem (%)', tipo: 'number', default: '6' },
    ],
  },
  {
    id: 'autorizacao_sem_exclusividade',
    arquivo: null,
    titulo: 'Autorização de Anúncio SEM Exclusividade',
    descricao: 'NOVO — Para proprietários que não dão exclusividade: autoriza anúncio/intermediação (venda ou locação) sem restringir outras imobiliárias ou negociação direta; comissão só é devida se o negócio for por intermediação desta imobiliária.',
    pessoas: [
      { prefixo: 'proprietario', rotulo: 'Proprietário(a) 1' },
      { prefixo: 'proprietario2', rotulo: 'Proprietário(a) 2 (opcional — cônjuge/coproprietário)', obrigatorio: false },
    ],
    nomeArquivoTag: 'proprietario_nome',
    paresValorExtenso: [['valor_pretendido', 'valor_pretendido_extenso']],
    computar(dados) {
      dados.tem_proprietario2 = !!(dados.proprietario2_nome && dados.proprietario2_nome.trim());
      dados.multiplos_imoveis_bool = /sim/i.test(dados.multiplos_imoveis || '');
    },
    campos: [
      { tag: 'multiplos_imoveis', rotulo: 'Múltiplos imóveis (construtora/incorporadora)?', tipo: 'select', full: true, opcoes: ['Não — um único imóvel', 'Sim — múltiplos imóveis (preencher a relação abaixo)'] },
      { tag: 'imoveis_lista_detalhada', rotulo: 'Relação de imóveis (1 por linha) — preencher se marcou "Sim" acima', tipo: 'textarea', full: true, placeholder: 'Lote 12, Quadra B, matrícula 4.567, área 300m², R$ 180.000,00\nLote 13, Quadra B, matrícula 4.568, área 300m², R$ 185.000,00\nApto 402, Ed. Aurora, matrícula 9.921, R$ 320.000,00' },
      { tag: 'imovel_tipo', rotulo: 'Imóvel único — tipo (deixe em branco se for múltiplos imóveis)', placeholder: 'Ex: apartamento, casa, terreno' },
      { tag: 'imovel_endereco_completo', rotulo: 'Imóvel único — endereço completo', full: true },
      { tag: 'imovel_matricula', rotulo: 'Imóvel único — matrícula' },
      { tag: 'imovel_descricao_detalhada', rotulo: 'Imóvel único — descrição detalhada', tipo: 'textarea', full: true, placeholder: 'Ex: sobrado com 2 dormitórios, sala, cozinha, banheiro' },
      { tag: 'finalidade_anuncio', rotulo: 'Finalidade', tipo: 'select', opcoes: ['venda', 'locação', 'venda ou locação'] },
      { tag: 'valor_pretendido', rotulo: 'Valor pretendido (R$) — só se for 1 imóvel único' },
      { tag: 'valor_pretendido_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'data_inicio_anuncio', rotulo: 'Início da vigência', tipo: 'date' },
      { tag: 'data_termino_anuncio', rotulo: 'Término da vigência', tipo: 'date' },
      { tag: 'tipos_publicidade_permitida_anuncio', rotulo: 'Tipos de publicidade permitida', tipo: 'textarea', full: true, default: 'anúncios escritos físicos e eletrônicos; impulsionamento de visualização; folders; placas; cartazes; e correspondência física ou eletrônica (e-mail); outras' },
      { tag: 'percentual_comissao_anuncio', rotulo: 'Comissão de corretagem, se concretizado por esta imobiliária (%)', tipo: 'number', default: '6' },
    ],
  },
  {
    id: 'recibo',
    arquivo: 'recibo_sinal_reserva.docx',
    titulo: 'Recibo de Sinal / Reserva',
    descricao: 'Recibo simples de valor recebido referente a sinal, reserva ou entrada.',
    pessoas: [{ prefixo: 'pagador', rotulo: 'Pagador(a)' }],
    imovel: true,
    nomeArquivoTag: 'pagador_nome',
    paresValorExtenso: [['valor_recebido', 'valor_recebido_extenso']],
    campos: [
      { tag: 'valor_recebido', rotulo: 'Valor recebido (R$)' },
      { tag: 'valor_recebido_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'finalidade_recibo', rotulo: 'Referente a', default: 'sinal de reserva' },
      { tag: 'condicao_recibo', rotulo: 'Condições', tipo: 'textarea', default: 'Este valor será integralmente abatido do valor total do negócio caso este se concretize; em caso de desistência por parte do(a) pagador(a), o valor poderá ser retido a título de indenização, conforme acordado entre as partes.' },
      { tag: 'recebedor_nome', rotulo: 'Nome de quem recebeu (assinatura)' },
    ],
  },
  {
    id: 'parceria',
    arquivo: 'contrato_parceria_imobiliarias.docx',
    titulo: 'Contrato de Parceria (imobiliária ou corretor autônomo)',
    descricao: 'Divisão de comissão, autoria de captação, confidencialidade e prazo da parceria — com outra imobiliária OU com corretor(a) autônomo(a).',
    nomeArquivoTag: 'parceiro_nome',
    computar(dados) {
      const ehAutonomo = /autonom|corretor/i.test(dados.tipo_parceiro || '');
      dados.titulo_parceria = ehAutonomo
        ? 'CONTRATO DE PARCERIA COM CORRETOR(A) AUTÔNOMO(A)'
        : 'CONTRATO DE PARCERIA ENTRE IMOBILIÁRIAS';
      dados.parceiro_label = ehAutonomo ? 'CORRETOR(A) AUTÔNOMO(A) PARCEIRO(A)' : 'IMOBILIÁRIA PARCEIRA';
      dados.parceiro_ref = ehAutonomo ? 'o(a) CORRETOR(A) AUTÔNOMO(A) PARCEIRO(A)' : 'a IMOBILIÁRIA PARCEIRA';
      const doc = dados.parceiro_documento ? `, ${ehAutonomo ? 'CPF' : 'CNPJ'} nº ${dados.parceiro_documento}` : '';
      const creci = dados.parceiro_creci ? `, CRECI ${dados.parceiro_creci}` : '';
      const end = dados.parceiro_endereco ? `, com ${ehAutonomo ? 'endereço' : 'sede'} em ${dados.parceiro_endereco}` : '';
      const rep = (!ehAutonomo && dados.parceiro_representante_nome)
        ? `, neste ato representada por ${dados.parceiro_representante_nome}${dados.parceiro_representante_cpf ? `, portador(a) do CPF nº ${dados.parceiro_representante_cpf}` : ''}`
        : '';
      dados.parceiro_qualificacao = `${dados.parceiro_nome || ''}${doc}${creci}${end}${rep}.`;
    },
    campos: [
      { tag: 'tipo_parceiro', rotulo: 'Tipo de parceiro', tipo: 'select', full: true, opcoes: ['Imobiliária', 'Corretor(a) autônomo(a)'] },
      { tag: 'parceiro_nome', rotulo: 'Parceiro — razão social (imobiliária) ou nome completo (corretor autônomo)', full: true },
      { tag: 'parceiro_documento', rotulo: 'Parceiro — CNPJ (imobiliária) ou CPF (corretor autônomo)' },
      { tag: 'parceiro_creci', rotulo: 'Parceiro — CRECI' },
      { tag: 'parceiro_endereco', rotulo: 'Parceiro — endereço / sede completo(a)', full: true },
      { tag: 'parceiro_representante_nome', rotulo: 'Representante da imobiliária — nome (só quando o parceiro for imobiliária)' },
      { tag: 'parceiro_representante_cpf', rotulo: 'Representante da imobiliária — CPF (só quando o parceiro for imobiliária)' },
      { tag: 'percentual_imobiliaria1', rotulo: 'Comissão — nossa imobiliária (%)', tipo: 'number', default: '50' },
      { tag: 'percentual_parceira', rotulo: 'Comissão — parceiro (%)', tipo: 'number', default: '50' },
      { tag: 'prazo_aviso_previo_dias', rotulo: 'Aviso prévio para rescisão (dias)', tipo: 'number', default: '30' },
      { tag: 'testemunha1_nome', rotulo: 'Testemunha 1 — nome' },
      { tag: 'testemunha1_cpf', rotulo: 'Testemunha 1 — CPF' },
      { tag: 'testemunha2_nome', rotulo: 'Testemunha 2 — nome' },
      { tag: 'testemunha2_cpf', rotulo: 'Testemunha 2 — CPF' },
    ],
  },
  {
    id: 'intermediacao_locacao',
    arquivo: 'contrato_intermediacao_locacao.docx',
    titulo: 'Contrato de Intermediação de Locação',
    descricao: 'Proprietário contrata a imobiliária para administrar a locação: taxa de administração, repasse e prazo.',
    pessoas: [{ prefixo: 'proprietario', rotulo: 'Proprietário(a)' }],
    imovel: true,
    nomeArquivoTag: 'proprietario_nome',
    campos: [
      { tag: 'taxa_administracao_percentual', rotulo: 'Taxa de administração (%)', tipo: 'number', default: '10' },
      { tag: 'dia_repasse', rotulo: 'Dia do repasse ao proprietário', tipo: 'number', default: '5' },
      { tag: 'forma_repasse', rotulo: 'Forma de repasse', default: 'depósito ou transferência bancária' },
      { tag: 'prazo_contrato_meses', rotulo: 'Prazo do contrato (meses)', tipo: 'number', default: '12' },
      { tag: 'prazo_aviso_rescisao_dias', rotulo: 'Aviso prévio para rescisão (dias)', tipo: 'number', default: '30' },
      { tag: 'obrigacoes_proprietario', rotulo: 'Obrigações adicionais do(a) proprietário(a)', tipo: 'textarea', full: true },
      { tag: 'testemunha1_nome', rotulo: 'Testemunha 1 — nome' },
      { tag: 'testemunha1_cpf', rotulo: 'Testemunha 1 — CPF' },
      { tag: 'testemunha2_nome', rotulo: 'Testemunha 2 — nome' },
      { tag: 'testemunha2_cpf', rotulo: 'Testemunha 2 — CPF' },
    ],
  },
  {
    id: 'direito_preferencia',
    arquivo: null,
    titulo: 'Notificação de Direito de Preferência (Venda)',
    descricao: 'NOVO — Aviso ao locatário de que o imóvel está à venda (art. 27, Lei 8.245/91), com prazo para manifestar interesse de compra ou desocupar.',
    pessoas: [{ prefixo: 'locatario', rotulo: 'Locatário(a) notificado(a)' }],
    imovel: true,
    nomeArquivoTag: 'locatario_nome',
    paresValorExtenso: [['valor_venda', 'valor_venda_extenso']],
    campos: [
      { tag: 'imovel_descricao_detalhada', rotulo: 'Imóvel — descrição detalhada', tipo: 'textarea', full: true, placeholder: 'Ex: terreno com duas casas' },
      { tag: 'valor_venda', rotulo: 'Valor de venda oferecido (R$)', placeholder: 'Ex: 330.000,00' },
      { tag: 'valor_venda_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'prazo_manifestacao_horas', rotulo: 'Prazo para manifestação (horas)', tipo: 'number', default: '24' },
      { tag: 'prazo_pagamento_avista_dias', rotulo: 'Prazo p/ quitação à vista, se houver interesse (dias)', tipo: 'number', default: '30' },
      { tag: 'prazo_desocupacao_dias', rotulo: 'Prazo p/ desocupação, se não houver interesse (dias)', tipo: 'number', default: '45' },
      { tag: 'observacoes_direito_preferencia', rotulo: 'Observações', tipo: 'textarea', full: true },
    ],
  },
  {
    id: 'distrato_locacao',
    arquivo: null,
    titulo: 'Distrato Consensual de Locação',
    descricao: 'NOVO — Rescisão amigável de contrato de locação: desocupação, devolução de caução, quitação e entrega das chaves.',
    pessoas: [
      { prefixo: 'locador', rotulo: 'Locador(a) — proprietário(a)' },
      { prefixo: 'locatario', rotulo: 'Locatário(a) (pessoa física ou jurídica)' },
    ],
    imovel: true,
    nomeArquivoTag: 'locatario_nome',
    campos: [
      { tag: 'locatario_responsavel_legal', rotulo: 'Responsável legal (se locatário for PJ)', placeholder: 'Ex: responsável legal Fulano de Tal, CPF 000.000.000-00' },
      { tag: 'data_contrato_original', rotulo: 'Data do contrato de locação original', tipo: 'date' },
      { tag: 'iniciativa_rescisao', rotulo: 'Iniciativa da rescisão', tipo: 'select', opcoes: ['do LOCATÁRIO, conforme manifestado expressamente à ADMINISTRADORA, com ciência e concordância do LOCADOR', 'do LOCADOR, conforme manifestado expressamente à ADMINISTRADORA, com ciência e concordância do LOCATÁRIO', 'de mútuo acordo entre LOCADOR e LOCATÁRIO'], full: true },
      { tag: 'data_termo_rescisao', rotulo: 'Data do termo da rescisão', tipo: 'date' },
      { tag: 'aplicacao_multa', rotulo: 'Multa rescisória', tipo: 'select', opcoes: ['sem aplicação de penalidade ou multa rescisória', 'com aplicação de multa rescisória, conforme cláusula correspondente do contrato de locação original'], full: true },
      { tag: 'prazo_desocupacao_data', rotulo: 'Data-limite para desocupação', tipo: 'date' },
      { tag: 'situacao_caucao', rotulo: 'Destinação da caução', tipo: 'select', opcoes: ['será integralmente retida pelo LOCADOR, para compensação dos débitos locatícios existentes e despesas de manutenção e reparos', 'será integralmente devolvida ao LOCATÁRIO, após a quitação de todas as obrigações', 'será parcialmente retida, conforme acordo específico entre as partes'], full: true },
      { tag: 'observacoes_distrato', rotulo: 'Observações adicionais', tipo: 'textarea', full: true },
    ],
  },
  {
    id: 'oferta_construtor',
    arquivo: null,
    titulo: 'Oferta de Imóvel para Construtora/Incorporadora',
    descricao: 'NOVO — Apresenta o imóvel a uma construtora/incorporadora nas modalidades de permuta por unidades, venda direta ou parceria/incorporação, com indicação de exclusividade ou não.',
    pessoas: [{ prefixo: 'proprietario', rotulo: 'Proprietário(a)/Ofertante' }],
    imovel: true,
    empresaConstrutora: true,
    nomeArquivoTag: 'construtora_razao_social',
    paresValorExtenso: [['valor_venda_direta', 'valor_venda_direta_extenso']],
    computar(dados) {
      const tipo = (dados.tipo_oferta || '').trim();
      dados.oferta_permuta = /^permuta/i.test(tipo);
      dados.oferta_venda_direta = /^venda direta/i.test(tipo);
      dados.oferta_parceria = /^parceria/i.test(tipo);
      dados.tem_exclusividade_bool = /sim/i.test(dados.tem_exclusividade || '');
    },
    campos: [
      { tag: 'imovel_potencial_construtivo', rotulo: 'Potencial construtivo / zoneamento', placeholder: 'Ex: zoneamento ZR-3, coeficiente de aproveitamento 2,0' },
      { tag: 'imovel_descricao_detalhada', rotulo: 'Imóvel — descrição detalhada', tipo: 'textarea', full: true, placeholder: 'Ex: terreno de esquina, topografia plana, testada de 20m' },
      { tag: 'tipo_oferta', rotulo: 'Modalidade da oferta', tipo: 'select', full: true, opcoes: ['Permuta por unidades', 'Venda direta', 'Parceria/incorporação'] },
      { tag: 'condicoes_permuta', rotulo: 'Condições da permuta (se aplicável)', tipo: 'textarea', full: true, placeholder: 'Ex: permuta de 20% das unidades construídas, a critério do proprietário quanto à escolha das unidades' },
      { tag: 'valor_venda_direta', rotulo: 'Valor da venda direta (R$), se aplicável', placeholder: 'Ex: 850.000,00' },
      { tag: 'valor_venda_direta_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'condicoes_parceria', rotulo: 'Condições da parceria/incorporação (se aplicável)', tipo: 'textarea', full: true, placeholder: 'Ex: parceria de risco, divisão de VGV conforme estudo de viabilidade' },
      { tag: 'tem_exclusividade', rotulo: 'Imóvel com exclusividade?', tipo: 'select', opcoes: ['Não', 'Sim'] },
      { tag: 'percentual_comissao_oferta', rotulo: 'Comissão de corretagem, se houver exclusividade (%)', tipo: 'number', default: '6' },
      { tag: 'prazo_validade_oferta_dias', rotulo: 'Prazo de validade da oferta (dias)', tipo: 'number', default: '15' },
      { tag: 'observacoes_oferta', rotulo: 'Observações adicionais', tipo: 'textarea', full: true },
    ],
  },
  {
    id: 'prestacao_contas',
    arquivo: null,
    titulo: 'Prestação de Contas — Repasse de Aluguel',
    descricao: 'NOVO — Presta contas ao proprietário sobre o aluguel recebido: descontos aplicados no repasse (com quantidade de parcelas) e outros gastos/lançamentos do período, discriminados em tabela, com cálculo automático do valor líquido repassado.',
    pessoas: [{ prefixo: 'proprietario', rotulo: 'Proprietário(a)' }],
    imovel: true,
    nomeArquivoTag: 'proprietario_nome',
    computar(dados) {
      const valorAluguel = parseValorBR(dados.valor_aluguel_bruto);
      const percentualTaxa = parseValorBR(dados.taxa_administracao_percentual);
      const valorTaxa = valorAluguel * (percentualTaxa / 100);
      const totalDescontos = somarLancamentosTextarea(dados.descontos_repasse_lista);
      const totalOutrosGastos = somarLancamentosTextarea(dados.outros_gastos_lista);
      const valorLiquido = valorAluguel - valorTaxa - totalDescontos - totalOutrosGastos;
      dados.valor_taxa_administracao_fmt = formatValorBR(valorTaxa);
      dados.total_descontos_fmt = formatValorBR(totalDescontos);
      dados.total_outros_gastos_fmt = formatValorBR(totalOutrosGastos);
      dados.valor_liquido_repassado_fmt = formatValorBR(valorLiquido);
      // padroniza a coluna de valor das tabelas (tira "R$", alinha o formato)
      dados.descontos_repasse_lista = normalizarColunaValorTextarea(dados.descontos_repasse_lista);
      dados.outros_gastos_lista = normalizarColunaValorTextarea(dados.outros_gastos_lista);
      dados.lancamentos_proximos_meses = normalizarColunaValorTextarea(dados.lancamentos_proximos_meses);
    },
    campos: [
      { tag: 'competencia_referencia', rotulo: 'Competência / mês de referência', placeholder: 'Ex: Agosto/2026' },
      { tag: 'data_repasse', rotulo: 'Data do repasse', tipo: 'date' },
      { tag: 'forma_repasse', rotulo: 'Forma de repasse', default: 'depósito ou transferência bancária' },
      { tag: 'valor_aluguel_bruto', rotulo: 'Valor bruto do aluguel recebido (R$)', placeholder: 'Ex: 1.800,00' },
      { tag: 'taxa_administracao_percentual', rotulo: 'Taxa de administração (%)', tipo: 'number', default: '10' },
      {
        tag: 'descontos_repasse_lista',
        rotulo: 'Descontos aplicados no repasse (1 por linha — Descrição | Valor (R$) | Parcela)',
        tipo: 'textarea',
        full: true,
        placeholder: 'Conserto hidráulico | 350,00 | 1/3\nMaterial elétrico | 120,00 | 2/2',
      },
      {
        tag: 'outros_gastos_lista',
        rotulo: 'Outros gastos/lançamentos do período (1 por linha — Descrição | Valor (R$))',
        tipo: 'textarea',
        full: true,
        placeholder: 'Taxa de vistoria de saída | 150,00\nMulta condominial repassada | 80,00',
      },
      {
        tag: 'lancamentos_proximos_meses',
        rotulo: 'Lançamentos previstos para os próximos meses (1 por linha — Descrição | Valor (R$))',
        tipo: 'textarea',
        full: true,
        placeholder: 'Parcela 2/6 — Sanepar | 114,16\nParcela 2/2 — Reforma e pintura | 825,00',
      },
      { tag: 'prazo_contestacao_prestacao_dias', rotulo: 'Prazo p/ o proprietário contestar (dias)', tipo: 'number', default: '10' },
      { tag: 'observacoes_prestacao', rotulo: 'Observações adicionais', tipo: 'textarea', full: true },
    ],
  },
  {
    id: 'autorizacao_caixa_pesquisa_cadastral',
    arquivo: null,
    titulo: 'Autorização Caixa — Pesquisa Cadastral',
    descricao: 'NOVO — Cópia fiel do formulário oficial Caixa 33.377 (sem identificação da imobiliária): autorização para pesquisa cadastral (SCR-BACEN) e/ou saldo de FGTS do(s) proponente(s)/coobrigado(s)/cônjuge(s) e vendedor(es).',
    nomeArquivoTag: 'proponente_nome',
    semBranding: true,
    computar(dados) {
      dados.consulta_cadastral_proponentes_bool = dados.consulta_cadastral_proponentes === 'Sim';
      dados.consulta_cadastral_vendedores_bool = dados.consulta_cadastral_vendedores === 'Sim';
      dados.consulta_saldo_fgts_bool = dados.consulta_saldo_fgts === 'Sim';
      dados.consulta_fgts_tres_anos_bool = dados.consulta_fgts_tres_anos === 'Sim';
      dados.tem_coobrigado = !!(dados.coobrigado_nome && dados.coobrigado_nome.trim());
      dados.tem_vendedor = !!(dados.vendedor_nome && dados.vendedor_nome.trim());
      dados.tem_conjuge_vendedor = !!(dados.conjuge_vendedor_nome && dados.conjuge_vendedor_nome.trim());
    },
    campos: [
      { tag: 'ul_cca_nome', rotulo: 'Unidade Lotérica / Correspondente CAIXA AQUI / Agência — nome (opcional)', full: true, placeholder: 'Ex: Agência Fazenda Rio Grande' },
      { tag: 'ul_cca_codigo', rotulo: 'Código da UL / CCA / Agência (opcional)' },
      { tag: 'consulta_cadastral_proponentes', rotulo: 'Pesquisa Cadastral do(s) Proponente(s)/Coobrigado(s)/Cônjuge(s)?', tipo: 'select', opcoes: ['Sim', 'Não'], default: 'Sim' },
      { tag: 'consulta_cadastral_vendedores', rotulo: 'Pesquisa Cadastral do(s) Vendedor(es)/Cônjuge(s)?', tipo: 'select', opcoes: ['Sim', 'Não'], default: 'Sim' },
      { tag: 'consulta_saldo_fgts', rotulo: 'Pesquisa do Saldo da CV FGTS do(s) Proponente(s)/Coobrigado(s)/Cônjuge(s)?', tipo: 'select', opcoes: ['Sim', 'Não'], default: 'Não' },
      { tag: 'consulta_fgts_tres_anos', rotulo: 'Verificar se possui(em) mais de 3 anos de FGTS?', tipo: 'select', opcoes: ['Sim', 'Não'], default: 'Não' },
      { tag: 'proponente_nome', rotulo: 'Proponente — nome completo' },
      { tag: 'proponente_cpf', rotulo: 'Proponente — CPF' },
      { tag: 'proponente_pis', rotulo: 'Proponente — PIS' },
      { tag: 'coobrigado_nome', rotulo: 'Coobrigado(a)/Cônjuge — nome completo (opcional)' },
      { tag: 'coobrigado_cpf', rotulo: 'Coobrigado(a)/Cônjuge — CPF' },
      { tag: 'coobrigado_pis', rotulo: 'Coobrigado(a)/Cônjuge — PIS' },
      { tag: 'vendedor_nome', rotulo: 'Vendedor(a) — nome/razão social (opcional)' },
      { tag: 'vendedor_cpf_cnpj', rotulo: 'Vendedor(a) — CPF/CNPJ' },
      { tag: 'conjuge_vendedor_nome', rotulo: 'Cônjuge do(a) Vendedor(a) — nome (opcional)' },
      { tag: 'conjuge_vendedor_cpf', rotulo: 'Cônjuge do(a) Vendedor(a) — CPF' },
      { tag: 'imovel_referencia', rotulo: 'Imóvel de referência da negociação (opcional)', full: true, placeholder: 'Ex: Apartamento situado na Rua X, nº 000, Bairro Y, Fazenda Rio Grande/PR' },
    ],
  },
  {
    id: 'fechamento_venda',
    arquivo: null,
    titulo: 'Fechamento de Venda — Prestação de Contas ao Proprietário',
    descricao: 'NOVO — Demonstrativo do fechamento da venda: valor do imóvel, comissões (percentual ou valor fixo, parceira e Gregório), saldo devedor bancário e demais descontos, com o valor líquido devido ao(à) proprietário(a)/vendedor(a) e a data prevista de repasse, calculado automaticamente linha a linha.',
    pessoas: [{ prefixo: 'vendedor', rotulo: 'Proprietário(a)/Vendedor(a)' }],
    imovel: true,
    nomeArquivoTag: 'vendedor_nome',
    paresValorExtenso: [['valor_venda_imovel', 'valor_venda_imovel_extenso']],
    computar(dados) {
      const entradas = [];

      // Comissão da imobiliária parceira: percentual (sobre o valor de venda) ou valor fixo.
      if (dados.tipo_comissao_parceira === 'Percentual') {
        const pct = parseValorBR(dados.comissao_parceira_percentual);
        const valor = parseValorBR(dados.valor_venda_imovel) * (pct / 100);
        if (pct > 0) entradas.push({ descricao: `Comissão imobiliária parceira (${formatValorBR(pct)}%)`, tipo: 'Débito', valor });
      } else if (dados.tipo_comissao_parceira === 'Valor fixo') {
        const valor = parseValorBR(dados.comissao_parceira_valor);
        if (valor > 0) entradas.push({ descricao: 'Comissão imobiliária parceira', tipo: 'Débito', valor });
      }

      // Base da comissão Gregório em percentual = valor de venda já descontada a comissão da parceira (se houver).
      let saldoAposParceira = parseValorBR(dados.valor_venda_imovel);
      entradas.forEach((e) => { saldoAposParceira -= e.valor; });

      if (dados.tipo_comissao_gregorio === 'Percentual') {
        const pct = parseValorBR(dados.comissao_gregorio_percentual);
        const valor = saldoAposParceira * (pct / 100);
        if (pct > 0) entradas.push({ descricao: `Comissão Gregório/Meu Lar (${formatValorBR(pct)}%)`, tipo: 'Débito', valor });
      } else if (dados.tipo_comissao_gregorio === 'Valor fixo') {
        const valor = parseValorBR(dados.comissao_gregorio_valor);
        if (valor > 0) entradas.push({ descricao: 'Comissão Gregório/Meu Lar', tipo: 'Débito', valor });
      }

      // Demais créditos/débitos digitados manualmente (saldo devedor bancário, reparos etc.).
      // Blindagem: se o corretor digitar um "|" extra dentro da própria descrição, o
      // formato "Descrição | Tipo | Valor" quebraria a tabela (o "|" é o separador de
      // coluna). Por isso os DOIS ÚLTIMOS pedaços são sempre tratados como Tipo/Valor,
      // e qualquer coisa antes disso vira a descrição — mesmo com pipes extras no meio.
      (dados.lancamentos_fechamento_lista || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((linha) => {
        const cols = linha.split('|').map((c) => c.trim());
        let descricao;
        let tipoRaw;
        let valorRaw;
        if (cols.length >= 3) {
          valorRaw = cols[cols.length - 1];
          tipoRaw = cols[cols.length - 2];
          descricao = cols.slice(0, cols.length - 2).join(' - ');
        } else {
          descricao = cols[0] || '';
          tipoRaw = cols[1] || '';
          valorRaw = cols[2] || '';
        }
        const tipo = (tipoRaw || '').toLowerCase().startsWith('c') ? 'Crédito' : 'Débito';
        const valor = parseValorBR(valorRaw || '');
        entradas.push({ descricao, tipo, valor });
      });

      let saldoCorrente = parseValorBR(dados.valor_venda_imovel);
      const linhasProcessadas = entradas.map((e) => {
        saldoCorrente = e.tipo === 'Débito' ? saldoCorrente - e.valor : saldoCorrente + e.valor;
        // Segunda camada de proteção: remove qualquer "|" residual da descrição
        // antes de montar a linha final da tabela (nunca deve sobrar nenhum,
        // mas evita quebra silenciosa caso o texto chegue aqui de outra forma).
        const descricaoSegura = String(e.descricao || '').replace(/\|/g, '/');
        return [descricaoSegura, e.tipo, formatValorBR(e.valor), formatValorBR(saldoCorrente)].join(' | ');
      });

      dados.lancamentos_fechamento_lista_processada = linhasProcessadas.join('\n');
      dados.valor_venda_imovel_fmt = formatValorBR(parseValorBR(dados.valor_venda_imovel));
      dados.valor_final_proprietario_fmt = formatValorBR(saldoCorrente);

      const diasContestacao = parseInt(dados.prazo_contestacao_fechamento_dias, 10) || 0;
      dados.prazo_contestacao_fechamento_texto = diasContestacao === 1 ? '1 dia corrido' : `${diasContestacao} dias corridos`;
    },
    campos: [
      { tag: 'valor_venda_imovel', rotulo: 'Valor de venda do imóvel (R$)', placeholder: 'Ex: 262.000,00' },
      { tag: 'valor_venda_imovel_extenso', rotulo: 'Valor por extenso (sugestão automática)', full: true },
      { tag: 'tipo_comissao_parceira', rotulo: 'Comissão imobiliária parceira — forma de cálculo', tipo: 'select', opcoes: ['Não há', 'Percentual', 'Valor fixo'], default: 'Valor fixo' },
      { tag: 'comissao_parceira_percentual', rotulo: 'Comissão parceira — percentual (%) — preencher só se "Percentual"', tipo: 'number', placeholder: 'Ex: 4,58' },
      { tag: 'comissao_parceira_valor', rotulo: 'Comissão parceira — valor fixo (R$) — preencher só se "Valor fixo"', placeholder: 'Ex: 12.000,00' },
      { tag: 'tipo_comissao_gregorio', rotulo: 'Comissão Gregório | Meu Lar — forma de cálculo', tipo: 'select', opcoes: ['Não há', 'Percentual', 'Valor fixo'], default: 'Percentual' },
      { tag: 'comissao_gregorio_percentual', rotulo: 'Comissão Gregório — percentual (%) — preencher só se "Percentual" (base: valor já descontada a comissão parceira)', tipo: 'number', default: '6' },
      { tag: 'comissao_gregorio_valor', rotulo: 'Comissão Gregório — valor fixo (R$) — preencher só se "Valor fixo"', placeholder: 'Ex: 15.000,00' },
      {
        tag: 'lancamentos_fechamento_lista',
        rotulo: 'Demais créditos e débitos do fechamento (1 por linha — Descrição | Tipo (Crédito/Débito) | Valor (R$) — não use "|" dentro da própria descrição)',
        tipo: 'textarea',
        full: true,
        placeholder: 'Saldo devedor bancário|Débito|152.560,18\nReparos no imóvel pago pela imobiliária ou comprador|Débito|0,00',
      },
      { tag: 'data_prevista_repasse', rotulo: 'Data prevista para o repasse ao proprietário', tipo: 'date' },
      { tag: 'prazo_contestacao_fechamento_dias', rotulo: 'Prazo p/ o proprietário contestar (dias)', tipo: 'number', default: '10' },
      { tag: 'observacoes_fechamento', rotulo: 'Observações adicionais', tipo: 'textarea', full: true },
    ],
  },
  {
    id: 'parecer_mercadologico',
    arquivo: null,
    titulo: 'Parecer Mercadológico de Avaliação Imobiliária',
    descricao: 'NOVO — Avaliação de imóvel pelo método comparativo de mercado (mínimo 3 imóveis comparados, com link do anúncio), com conclusão de valor sugerido e posicionamento de preço (alto/médio/baixo). Vale para venda ou locação de terreno, casa, sobrado, apartamento, área rural ou comércio.',
    nomeArquivoTag: 'solicitante_nome',
    computar(dados) {
      const linhas = (dados.comparados_lista || '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (linhas.length < 3) {
        throw new Error('Informe pelo menos 3 imóveis comparados (mínimo exigido pelo método comparativo de mercado).');
      }
    },
    campos: [
      { tag: 'finalidade', rotulo: 'Finalidade', tipo: 'select', opcoes: ['Venda', 'Locação'], default: 'Venda' },
      { tag: 'tipo_imovel', rotulo: 'Tipo de imóvel', tipo: 'select', opcoes: ['Terreno', 'Casa', 'Sobrado', 'Apartamento', 'Área Rural', 'Comércio'], default: 'Casa' },
      { tag: 'solicitante_nome', rotulo: 'Solicitante — nome completo' },
      { tag: 'solicitante_cpf', rotulo: 'Solicitante — CPF' },
      { tag: 'imovel_avaliado_endereco', rotulo: 'Imóvel avaliado — endereço completo', full: true, placeholder: 'Ex: Rua X, nº 000, Bairro Y, Fazenda Rio Grande/PR' },
      { tag: 'imovel_avaliado_area', rotulo: 'Área (construída e/ou terreno)', placeholder: 'Ex: 120 m² de área construída / 250 m² de terreno' },
      { tag: 'imovel_avaliado_matricula', rotulo: 'Matrícula ou Inscrição Imobiliária (opcional)' },
      { tag: 'imovel_avaliado_descricao', rotulo: 'Características do imóvel avaliado', tipo: 'textarea', full: true, linhas: 3, placeholder: 'Ex: casa térrea com 3 dormitórios, 2 banheiros, garagem para 2 carros, acabamento padrão médio, construção com aproximadamente 10 anos, em bom estado de conservação.' },
      { tag: 'foto_imovel', rotulo: 'Fotos do imóvel avaliado (opcional, pode selecionar mais de uma)', tipo: 'imagem', multiplo: true },
      {
        tag: 'comparados_lista',
        rotulo: 'Imóveis comparados — mínimo 3 (1 por linha: Descrição | Valor (R$) | Área | Link do anúncio)',
        tipo: 'textarea',
        full: true,
        linhas: 4,
        placeholder: 'Casa 3 dorm., mesmo bairro|380.000,00|130 m²|https://www.imovelweb.com.br/anuncio-1\nCasa 3 dorm., bairro vizinho|365.000,00|118 m²|https://www.imovelweb.com.br/anuncio-2\nCasa 2 dorm., mesma rua|340.000,00|105 m²|https://www.imovelweb.com.br/anuncio-3',
      },
      { tag: 'valor_sugerido', rotulo: 'Valor sugerido (R$)', placeholder: 'Ex: 365.000,00' },
      { tag: 'posicionamento_mercado', rotulo: 'Posicionamento do preço sugerido', tipo: 'select', opcoes: ['Preço ALTO (acima da média de mercado)', 'Preço MÉDIO (dentro da média de mercado)', 'Preço BAIXO (abaixo da média — venda/locação mais rápida)'], default: 'Preço MÉDIO (dentro da média de mercado)' },
      {
        tag: 'parecer_texto',
        rotulo: 'Parecer / conclusão do avaliador (texto padrão pronto — edite antes de gerar)',
        tipo: 'textarea',
        full: true,
        linhas: 8,
        default: 'Com base na pesquisa e análise comparativa dos imóveis pesquisados na mesma região, que apresentam características físicas, de localização e de padrão construtivo semelhantes ao imóvel avaliado, verifica-se que os valores atualmente praticados no mercado local são compatíveis com o valor sugerido neste parecer.\n\nA presente análise considerou, entre outros fatores: a localização do imóvel e sua proximidade a comércios, serviços e vias de acesso; o padrão construtivo e o estado de conservação; a área construída e/ou de terreno; e a liquidez de mercado, ou seja, o tempo médio observado para venda ou locação de imóveis semelhantes na região.\n\nDessa forma, recomenda-se ao(à) solicitante considerar o valor sugerido como referência inicial para negociação, podendo haver ajustes conforme a urgência da negociação, as condições específicas de pagamento e eventuais particularidades do imóvel não contempladas nesta análise.',
      },
    ],
  },
];

function qualificacaoPessoaDocHtml(prefixo, rotulo, obrigatorio = true) {
  const opcoesPessoas = pessoasCache.slice().sort((a, b) => a.nome.localeCompare(b.nome))
    .map((p) => `<option value="${p.id}">${p.nome}</option>`).join('');
  const campos = CAMPOS_PESSOA_DOC.map(([campo, label, req, full]) => `
    <div class="form-row${full ? ' full' : ''}"><label>${label}</label>
      <input ${req && obrigatorio ? 'required' : ''} id="doc-${prefixo}-${campo}" value="${campo === 'nacionalidade' ? 'Brasileira' : ''}">
    </div>
  `).join('');
  return `
    <fieldset class="doc-fieldset">
      <legend>${rotulo}</legend>
      <div class="form-row full"><label>Puxar pessoa cadastrada (opcional)</label>
        <select class="doc-pessoa-picker" data-prefixo="${prefixo}">
          <option value="">— Preencher manualmente —</option>
          ${opcoesPessoas}
        </select>
      </div>
      ${campos}
    </fieldset>
  `;
}

function qualificacaoImovelDocHtml() {
  const opcoesImoveis = imoveisCache.slice().sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''))
    .map((im) => `<option value="${im.id}">${im.titulo || 'sem título'}${im.codigo ? ' (' + im.codigo + ')' : ''}</option>`).join('');
  return `
    <fieldset class="doc-fieldset">
      <legend>Imóvel</legend>
      <div class="form-row full"><label>Selecionar imóvel cadastrado (opcional)</label>
        <select class="doc-imovel-picker">
          <option value="">— Preencher manualmente —</option>
          ${opcoesImoveis}
        </select>
      </div>
      <div class="form-row full"><label>Endereço completo</label><input required id="doc-imovel_endereco_completo"></div>
      <div class="form-row"><label>Matrícula (cartório)</label><input id="doc-imovel_matricula"></div>
      <div class="form-row"><label>Tipo</label><input id="doc-imovel_tipo"></div>
      <div class="form-row"><label>Área total (m²)</label><input id="doc-imovel_area_total"></div>
      <div class="form-row"><label>Área construída (m²)</label><input id="doc-imovel_area_construida"></div>
    </fieldset>
  `;
}

function qualificacaoEmpresaDocHtml(prefixo, rotulo) {
  return `
    <fieldset class="doc-fieldset">
      <legend>${rotulo}</legend>
      <div class="form-row full"><label>Razão social</label><input required id="doc-${prefixo}-razao_social"></div>
      <div class="form-row"><label>CNPJ</label><input id="doc-${prefixo}-cnpj"></div>
      <div class="form-row"><label>CRECI</label><input id="doc-${prefixo}-creci"></div>
      <div class="form-row full"><label>Endereço completo</label><input id="doc-${prefixo}-endereco"></div>
      <div class="form-row"><label>Representante — nome</label><input id="doc-${prefixo}-representante_nome"></div>
      <div class="form-row"><label>Representante — CPF</label><input id="doc-${prefixo}-representante_cpf"></div>
    </fieldset>
  `;
}

function campoDocHtml(campo) {
  const val = campo.default !== undefined ? campo.default : '';
  const fullClass = campo.full ? ' full' : '';
  if (campo.tipo === 'select') {
    return `<div class="form-row${fullClass}"><label>${campo.rotulo}</label>
      <select id="doc-${campo.tag}">${(campo.opcoes || []).map((op) => `<option value="${op}" ${op === val ? 'selected' : ''}>${op}</option>`).join('')}</select>
    </div>`;
  }
  if (campo.tipo === 'textarea') {
    return `<div class="form-row full"><label>${campo.rotulo}</label><textarea id="doc-${campo.tag}" rows="${campo.linhas || 2}">${val}</textarea></div>`;
  }
  if (campo.tipo === 'imagem') {
    return `<div class="form-row full"><label>${campo.rotulo}</label><input type="file" id="doc-${campo.tag}" accept="image/*" ${campo.multiplo ? 'multiple' : ''}></div>`;
  }
  const tipoInput = (campo.tipo === 'date' || campo.tipo === 'number') ? campo.tipo : 'text';
  return `<div class="form-row${fullClass}"><label>${campo.rotulo}</label><input type="${tipoInput}" id="doc-${campo.tag}" value="${val}" ${campo.placeholder ? `placeholder="${campo.placeholder}"` : ''}></div>`;
}

function documentoDocForm(modelo, modoEdicao) {
  let html = `<h2>${modelo.titulo}</h2><p class="modal-subtitle">${modoEdicao ? 'Corrigindo um documento já emitido — ao salvar, o PDF anterior é substituído por este no histórico.' : modelo.descricao}</p><form class="modal-form" id="documentoDocForm">`;
  (modelo.pessoas || []).forEach((p) => { html += qualificacaoPessoaDocHtml(p.prefixo, p.rotulo, p.obrigatorio !== false); });
  if (modelo.fiadorOpcional) {
    html += `
      <fieldset class="doc-fieldset">
        <legend>Garantia locatícia</legend>
        <div class="form-row full"><label class="check-row"><input type="checkbox" id="doc-tem-fiador"> Esta locação terá fiador</label></div>
        <div id="doc-bloco-fiador" hidden>${qualificacaoPessoaDocHtml('fiador', 'Fiador(a)', false)}</div>
        <div class="form-row full" id="doc-bloco-outra-garantia"><label>Outra garantia (caução, seguro-fiança etc.)</label><input id="doc-tipo_garantia_outra" value="caução em dinheiro equivalente a 3 (três) meses de aluguel"></div>
      </fieldset>
    `;
  }
  if (modelo.imovel) html += qualificacaoImovelDocHtml();
  if (modelo.empresaParceira) html += qualificacaoEmpresaDocHtml('parceira', 'Imobiliária Parceira');
  if (modelo.empresaConstrutora) html += qualificacaoEmpresaDocHtml('construtora', modelo.rotuloConstrutora || 'Construtora/Incorporadora (Destinatária)');
  (modelo.campos || []).forEach((c) => { html += campoDocHtml(c); });
  html += `
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="cancelDocumentoDoc">Cancelar</button>
      <button type="submit" class="btn btn-primary">${modoEdicao ? 'Salvar correção (.pdf)' : 'Gerar documento (.pdf)'}</button>
    </div>
  </form>`;
  return html;
}

function autofillPessoaDoc(prefixo, id) {
  if (!id) return;
  const p = pessoasCache.find((x) => x.id === id);
  if (!p) return;
  const mapa = { nome: p.nome, nacionalidade: p.nacionalidade || 'Brasileira', estado_civil: p.estado_civil, profissao: p.profissao, rg: p.rg, cpf: p.cpf_cnpj, telefone: p.telefone, email: p.email, endereco: p.endereco };
  Object.entries(mapa).forEach(([campo, valor]) => {
    const el = $(`#doc-${prefixo}-${campo}`);
    if (el) el.value = valor || '';
  });
}

function autofillImovelDoc(id) {
  if (!id) return;
  const im = imoveisCache.find((x) => x.id === id);
  if (!im) return;
  const partes = [im.endereco, im.numero ? 'nº ' + im.numero : '', im.complemento, im.bairro].filter(Boolean).join(', ');
  const enderecoCompleto = [partes, [im.cidade, im.estado].filter(Boolean).join('/')].filter(Boolean).join(' — ');
  if ($('#doc-imovel_endereco_completo')) $('#doc-imovel_endereco_completo').value = enderecoCompleto;
  if ($('#doc-imovel_matricula')) $('#doc-imovel_matricula').value = im.matricula || '';
  if ($('#doc-imovel_tipo')) $('#doc-imovel_tipo').value = im.tipo || '';
  if ($('#doc-imovel_area_total')) $('#doc-imovel_area_total').value = im.area_total || '';
  if ($('#doc-imovel_area_construida')) $('#doc-imovel_area_construida').value = im.area_construida || '';
}

// ---- número por extenso (reais), usado como sugestão editável ----
const DOC_UNIDADES = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const DOC_DEZENAS10 = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DOC_DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const DOC_CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function docTrioExtenso(n) {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const h = Math.floor(n / 100);
  const r = n % 100;
  const partes = [];
  if (h) partes.push(DOC_CENTENAS[h]);
  if (r) {
    if (r < 10) partes.push(DOC_UNIDADES[r]);
    else if (r < 20) partes.push(DOC_DEZENAS10[r - 10]);
    else { const t = Math.floor(r / 10); const u = r % 10; partes.push(DOC_DEZENAS[t] + (u ? ' e ' + DOC_UNIDADES[u] : '')); }
  }
  return partes.join(' e ');
}

function docInteiroExtenso(n) {
  if (n === 0) return 'zero';
  const milhoes = Math.floor(n / 1000000);
  const milhares = Math.floor((n % 1000000) / 1000);
  const unidades = n % 1000;
  const partes = [];
  if (milhoes) partes.push(docTrioExtenso(milhoes) + (milhoes === 1 ? ' milhão' : ' milhões'));
  if (milhares) partes.push(milhares === 1 ? 'mil' : docTrioExtenso(milhares) + ' mil');
  if (unidades || partes.length === 0) partes.push(docTrioExtenso(unidades));
  return partes.filter(Boolean).join(' e ');
}

function valorPorExtensoDoc(valorTexto) {
  const numero = Number(String(valorTexto || '').replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  if (!isFinite(numero) || numero <= 0) return '';
  const valor = Math.round(numero * 100) / 100;
  const reais = Math.floor(valor);
  const centavos = Math.round((valor - reais) * 100);
  let texto = docInteiroExtenso(reais) + (reais === 1 ? ' real' : ' reais');
  if (centavos > 0) texto += ' e ' + docInteiroExtenso(centavos) + (centavos === 1 ? ' centavo' : ' centavos');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// Repopula o formulário de geração de documento com os dados salvos de uma
// emissão anterior (dados_json), usando exatamente os mesmos ids de campo
// que coletarDadosDocumentoDoc lê — mantém as duas funções em espelho.
function preencherFormularioDocComDados(modelo, dadosExistentes) {
  if (!dadosExistentes) return;
  const setVal = (id, valor) => {
    const el = $(`#${id}`);
    if (el && valor !== undefined && valor !== null) el.value = valor;
  };
  (modelo.pessoas || []).forEach((p) => {
    CAMPOS_PESSOA_DOC.forEach(([campo]) => setVal(`doc-${p.prefixo}-${campo}`, dadosExistentes[`${p.prefixo}_${campo}`]));
  });
  if (modelo.fiadorOpcional) {
    const chk = $('#doc-tem-fiador');
    if (chk && dadosExistentes.tem_fiador) {
      chk.checked = true;
      chk.dispatchEvent(new Event('change'));
    }
    CAMPOS_PESSOA_DOC.forEach(([campo]) => setVal(`doc-fiador-${campo}`, dadosExistentes[`fiador_${campo}`]));
    setVal('doc-tipo_garantia_outra', dadosExistentes.tipo_garantia_outra);
  }
  if (modelo.imovel) {
    ['imovel_endereco_completo', 'imovel_matricula', 'imovel_tipo', 'imovel_area_total', 'imovel_area_construida'].forEach((tag) => setVal(`doc-${tag}`, dadosExistentes[tag]));
  }
  if (modelo.empresaParceira) {
    ['razao_social', 'cnpj', 'creci', 'endereco', 'representante_nome', 'representante_cpf'].forEach((campo) => setVal(`doc-parceira-${campo}`, dadosExistentes[`parceira_${campo}`]));
  }
  if (modelo.empresaConstrutora) {
    ['razao_social', 'cnpj', 'creci', 'endereco', 'representante_nome', 'representante_cpf'].forEach((campo) => setVal(`doc-construtora-${campo}`, dadosExistentes[`construtora_${campo}`]));
  }
  (modelo.campos || []).forEach((c) => { if (c.tipo !== 'imagem') setVal(`doc-${c.tag}`, dadosExistentes[c.tag]); });
  // Campos de "valor por extenso" já vêm preenchidos acima — marca como não
  // mais automáticos, senão o listener de input recalcularia por cima ao
  // simplesmente focar/desfocar o campo de valor correspondente.
  (modelo.paresValorExtenso || []).forEach(([, tagExtenso]) => {
    const el = $(`#doc-${tagExtenso}`);
    if (el) el.dataset.auto = '0';
  });
}

function bindDocumentoDocForm(modelo, registroEdicao) {
  $('#cancelDocumentoDoc').addEventListener('click', closeModal);

  $$('.doc-pessoa-picker').forEach((sel) => {
    sel.addEventListener('change', () => autofillPessoaDoc(sel.dataset.prefixo, sel.value));
  });
  const imovelPicker = $('.doc-imovel-picker');
  if (imovelPicker) imovelPicker.addEventListener('change', () => autofillImovelDoc(imovelPicker.value));

  if (modelo.fiadorOpcional) {
    const chk = $('#doc-tem-fiador');
    const blocoFiador = $('#doc-bloco-fiador');
    const blocoOutra = $('#doc-bloco-outra-garantia');
    chk.addEventListener('change', () => {
      blocoFiador.hidden = !chk.checked;
      blocoOutra.hidden = chk.checked;
    });
  }

  (modelo.paresValorExtenso || []).forEach(([tagValor, tagExtenso]) => {
    const inputValor = $(`#doc-${tagValor}`);
    const inputExtenso = $(`#doc-${tagExtenso}`);
    if (!inputValor || !inputExtenso) return;
    inputExtenso.dataset.auto = '1';
    inputExtenso.addEventListener('input', () => { inputExtenso.dataset.auto = '0'; });
    inputValor.addEventListener('input', () => {
      if (inputExtenso.dataset.auto !== '0') inputExtenso.value = valorPorExtensoDoc(inputValor.value);
    });
  });

  if (registroEdicao) preencherFormularioDocComDados(modelo, registroEdicao.dados_json);

  $('#documentoDocForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = registroEdicao ? 'Salvando...' : 'Gerando...';
    try {
      const dados = await coletarDadosDocumentoDoc(modelo);
      if (registroEdicao) {
        await salvarEdicaoDocumentoGerado(modelo, dados, registroEdicao);
        toast('Documento corrigido — o PDF anterior foi substituído.');
        closeModal();
        carregarHistoricoDocumentos();
      } else {
        await gerarDocumentoDocx(modelo, dados);
        toast('Documento gerado com sucesso.');
        closeModal();
        ofertarCriarContratoDeDocumento(modelo, dados);
      }
    } catch (err) {
      console.error(err);
      toast(`Erro ao ${registroEdicao ? 'salvar a correção' : 'gerar documento'}: ` + err.message, true);
    }
    btn.disabled = false;
    btn.textContent = registroEdicao ? 'Salvar correção (.pdf)' : 'Gerar documento (.pdf)';
  });
}

// Depois de gerar um documento, oferece já criar/atualizar o registro
// correspondente no sistema — evita digitar tudo de novo manualmente.
// - Locação e Compra e Venda: cria um contrato em `contratos`.
// - Proposta de Compra (com/sem incorporadora) e Ficha de Visita: avança
//   (ou cria) o lead da pessoa envolvida na etapa certa do funil.
function ofertarCriarContratoDeDocumento(modelo, dados) {
  if (modelo.id === 'locacao' || modelo.id === 'locacao_comercial') {
    return ofertarCriarContratoLocacao(modelo, dados);
  }
  if (modelo.id === 'compra_venda') {
    return ofertarCriarContratoVenda(modelo, dados);
  }
  if (modelo.id === 'proposta_compra' || modelo.id === 'proposta_compra_planta') {
    return ofertarAvancarLeadDeDocumento(dados, 'proponente', 'proposta', 'compra');
  }
  if (modelo.id === 'ficha_visita_reserva') {
    const interesse = (dados.interesse_visita || '').toLowerCase().startsWith('loca') ? 'locacao' : 'compra';
    return ofertarAvancarLeadDeDocumento(dados, 'visitante', 'visita_feita', interesse);
  }
}

function ofertarCriarContratoLocacao(modelo, dados) {
  if (!confirm('Documento gerado. Deseja já criar o contrato de locação no sistema com estes mesmos dados?')) return;

  const prefill = {
    imovel_id: dados.imovel_id_real || '',
    tipo: 'locacao',
    status: 'ativo',
    comprador_locatario_id: dados.locatario_pessoa_id || '',
    vendedor_locador_id: dados.locador_pessoa_id || '',
    valor: parseValorBR(dados.valor_aluguel) || '',
    data_inicio: dados.data_inicio || '',
    data_fim: dados.data_termino || '',
    dia_vencimento: dados.dia_vencimento || '',
    multa_percentual: dados.multa_atraso_percentual || '',
    juros_diario_percentual: dados.juros_mora_percentual || '',
  };

  (async () => {
    openModal(await contratoForm(prefill));
    bindContratoForm();
    const faltando = [];
    if (!prefill.imovel_id) faltando.push('imóvel');
    if (!prefill.comprador_locatario_id) faltando.push('locatário');
    if (!prefill.vendedor_locador_id) faltando.push('locador');
    if (faltando.length) {
      toast(`Contrato pré-preenchido com os valores do documento — mas selecione manualmente: ${faltando.join(', ')} (não foram escolhidos da lista de cadastro ao gerar o documento, foram digitados à mão).`);
    }
  })();
}

function ofertarCriarContratoVenda(modelo, dados) {
  if (!confirm('Documento gerado. Deseja já criar o contrato de venda no sistema com estes mesmos dados?')) return;

  const hoje = new Date().toISOString().slice(0, 10);
  const prefill = {
    imovel_id: dados.imovel_id_real || '',
    tipo: 'venda',
    status: 'ativo',
    comprador_locatario_id: dados.comprador_pessoa_id || '',
    vendedor_locador_id: dados.vendedor_pessoa_id || '',
    valor: parseValorBR(dados.valor_venda) || '',
    data_inicio: hoje,
    comissao_valor: parseValorBR(dados.valor_comissao) || '',
  };

  (async () => {
    openModal(await contratoForm(prefill));
    bindContratoForm();
    const faltando = [];
    if (!prefill.imovel_id) faltando.push('imóvel');
    if (!prefill.comprador_locatario_id) faltando.push('comprador');
    if (!prefill.vendedor_locador_id) faltando.push('vendedor');
    if (faltando.length) {
      toast(`Contrato pré-preenchido com os valores do documento — mas selecione manualmente: ${faltando.join(', ')} (não foram escolhidos da lista de cadastro ao gerar o documento, foram digitados à mão).`);
    }
  })();
}

// Avança (ou cria) o lead da pessoa envolvida no documento (proponente/visitante)
// pra etapa indicada do funil. Procura primeiro um lead já existente (por
// pessoa vinculada ou telefone); só cria um novo se realmente não achar nenhum.
function ofertarAvancarLeadDeDocumento(dados, prefixo, etapaAlvo, interesse) {
  const nome = dados[`${prefixo}_nome`];
  const telefone = dados[`${prefixo}_telefone`];
  const email = dados[`${prefixo}_email`];
  const pessoaId = dados[`${prefixo}_pessoa_id`] || null;
  if (!nome && !telefone) return; // nada preenchido, nada a fazer

  const nomeEtapa = LEAD_STATUS_LABELS?.[etapaAlvo] || etapaAlvo.replace(/_/g, ' ');
  if (!confirm(`Documento gerado. Deseja registrar/avançar "${nome}" no funil de leads (etapa: ${nomeEtapa})?`)) return;

  (async () => {
    let query = supabase.from('leads').select('id,nome,status').limit(1);
    query = pessoaId ? query.eq('pessoa_id', pessoaId) : query.eq('telefone', telefone || '__sem_telefone__');
    const { data: existentes } = await query;
    const existente = existentes?.[0];

    if (existente) {
      const { error } = await supabase.from('leads').update({ status: etapaAlvo, imovel_id: dados.imovel_id_real || undefined }).eq('id', existente.id);
      if (error) { toast('Erro ao avançar lead: ' + error.message, true); console.error(error); return; }
      toast(`Lead de "${existente.nome}" avançado para "${nomeEtapa}".`);
    } else {
      const payload = {
        nome: nome || 'Sem nome',
        telefone: telefone || '',
        email: email || null,
        origem: 'presencial',
        interesse,
        imovel_id: dados.imovel_id_real || null,
        pessoa_id: pessoaId,
        corretor_id: currentUsuario?.id || null,
        status: etapaAlvo,
      };
      const { error } = await supabase.from('leads').insert(payload);
      if (error) { toast('Erro ao criar lead: ' + error.message, true); console.error(error); return; }
      toast(`Lead de "${nome}" criado já na etapa "${nomeEtapa}".`);
    }
    loadLeads();
    loadDashboard();
  })();
}

async function coletarDadosDocumentoDoc(modelo) {
  const dados = {};
  (modelo.pessoas || []).forEach((p) => {
    CAMPOS_PESSOA_DOC.forEach(([campo]) => { dados[`${p.prefixo}_${campo}`] = ($(`#doc-${p.prefixo}-${campo}`)?.value || '').trim(); });
    const picker = $(`.doc-pessoa-picker[data-prefixo="${p.prefixo}"]`);
    if (picker && picker.value) dados[`${p.prefixo}_pessoa_id`] = picker.value;
  });
  if (modelo.fiadorOpcional) {
    const temFiador = $('#doc-tem-fiador').checked;
    dados.tem_fiador = temFiador;
    CAMPOS_PESSOA_DOC.forEach(([campo]) => {
      dados[`fiador_${campo}`] = temFiador ? ($(`#doc-fiador-${campo}`)?.value || '').trim() : '';
    });
    dados.tipo_garantia_outra = temFiador ? '' : ($('#doc-tipo_garantia_outra')?.value || '').trim();
  }
  if (modelo.imovel) {
    ['imovel_endereco_completo', 'imovel_matricula', 'imovel_tipo', 'imovel_area_total', 'imovel_area_construida'].forEach((tag) => {
      dados[tag] = ($(`#doc-${tag}`)?.value || '').trim();
    });
    const imovelPicker = $('.doc-imovel-picker');
    if (imovelPicker && imovelPicker.value) dados.imovel_id_real = imovelPicker.value;
  }
  if (modelo.empresaParceira) {
    ['razao_social', 'cnpj', 'creci', 'endereco', 'representante_nome', 'representante_cpf'].forEach((campo) => {
      dados[`parceira_${campo}`] = ($(`#doc-parceira-${campo}`)?.value || '').trim();
    });
  }
  if (modelo.empresaConstrutora) {
    ['razao_social', 'cnpj', 'creci', 'endereco', 'representante_nome', 'representante_cpf'].forEach((campo) => {
      dados[`construtora_${campo}`] = ($(`#doc-construtora-${campo}`)?.value || '').trim();
    });
  }
  // Campos tipo 'imagem' são lidos à parte (assíncrono — FileReader) e viram
  // um array de data-URIs base64; os demais tipos continuam leitura direta.
  for (const c of (modelo.campos || [])) {
    if (c.tipo === 'imagem') {
      const input = $(`#doc-${c.tag}`);
      const arquivos = input?.files ? Array.from(input.files) : [];
      dados[c.tag] = await Promise.all(arquivos.map((f) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      })));
    } else {
      dados[c.tag] = ($(`#doc-${c.tag}`)?.value || '').trim();
    }
  }
  if (typeof modelo.computar === 'function') modelo.computar(dados);

  const cs = configSiteDocCache || {};
  const hoje = new Date();
  Object.assign(dados, {
    imobiliaria_nome: 'GREGÓRIO | MEU LAR IMOBILIÁRIA',
    imobiliaria_creci: cs.creci || 'J-7281',
    imobiliaria_razao_social: cs.razao_social || '',
    imobiliaria_cnpj: cs.cnpj || '',
    imobiliaria_cidade: cs.cidade || 'Fazenda Rio Grande',
    imobiliaria_estado: cs.estado || 'PR',
    imobiliaria_endereco: cs.endereco || '',
    imobiliaria_endereco_completo: [cs.endereco, [cs.cidade || 'Fazenda Rio Grande', cs.estado || 'PR'].filter(Boolean).join('/')].filter(Boolean).join(' — '),
    imobiliaria_telefone: cs.whatsapp_telefone || cs.telefone_fixo || '',
    imobiliaria_email: cs.email || '',
    corretor_nome: currentUsuario?.nome || '',
    corretor_creci: currentUsuario?.creci || '',
    // Identificação de quem assina fisicamente pela ADMINISTRADORA (aparece
    // como linha de apoio abaixo da assinatura fixa, junto ao nome da
    // imobiliária) — ver blocoParaPdf/case 'assinaturas' em doc-pdf.js.
    assinante_nome: 'LUIZ GREGORIO PEREIRA',
    assinante_cpf: '037.177.869-70',
    cidade_contrato: cs.cidade || 'Fazenda Rio Grande',
    data_extenso: hoje.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }),
  });
  return dados;
}

const MODELOS_DOC_STORAGE_PASTA = 'modelos-documentos';

async function obterTextoPersonalizadoModelo(modelo) {
  try {
    const url = supabase.storage.from('site-imagens').getPublicUrl(`${MODELOS_DOC_STORAGE_PASTA}/${modelo.id}.txt`).data.publicUrl;
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) return null;
    const texto = await resp.text();
    return texto.trim() ? texto : null;
  } catch {
    return null;
  }
}

async function gerarDocumentoDocx(modelo, dados) {
  // Geração em PDF (motor interno, window.gerarPdfDocumento — ver js/doc-pdf.js).
  // Trocado de .docx para .pdf porque o merge via docxtemplater corrompia o
  // cabeçalho (header1.xml) de alguns documentos ao reescrever a marca d'água
  // flutuante, impedindo a abertura no Word. O texto do corpo pode ter sido
  // personalizado por gerente/admin (ver obterTextoPersonalizadoModelo).
  const textoPersonalizado = await obterTextoPersonalizadoModelo(modelo);
  const resultado = await window.gerarPdfDocumento(modelo, dados, textoPersonalizado);
  registrarDocumentoGerado(modelo, dados, resultado); // não aguarda: nunca atrasa/bloqueia o download do corretor
}

const DOCUMENTOS_GERADOS_STORAGE_BUCKET = 'documentos-gerados';
let historicoDocsCache = [];

// Histórico de documentos gerados (gerente/admin acompanham tudo; cada
// corretor vê o próprio). Roda em segundo plano: se falhar (ex.: sem
// internet num momento ruim), o corretor já recebeu o PDF normalmente —
// só perde o registro desse único documento no histórico.
async function registrarDocumentoGerado(modelo, dados, resultado) {
  if (!resultado?.blob || !currentUsuario?.id) return;
  try {
    const caminho = `${currentUsuario.id}/${resultado.nomeArquivo}`;
    const { error: erroUpload } = await supabase.storage
      .from(DOCUMENTOS_GERADOS_STORAGE_BUCKET)
      .upload(caminho, resultado.blob, { contentType: 'application/pdf', upsert: true });
    // Campos tipo 'imagem' viram data-URIs base64 grandes (podem passar de
    // 1MB por foto) — o PDF final já tem elas embutidas, então não faz
    // sentido duplicar esse peso dentro da tabela. Salva só a contagem.
    const dadosParaHistorico = { ...dados };
    (modelo.campos || []).forEach((c) => {
      if (c.tipo === 'imagem' && Array.isArray(dadosParaHistorico[c.tag])) {
        dadosParaHistorico[c.tag] = `[${dadosParaHistorico[c.tag].length} foto(s) anexada(s) na geração original — não é possível trocar ao editar, é preciso reanexar]`;
      }
    });
    const { error: erroInsert } = await supabase.from('documentos_gerados').insert({
      modelo_id: modelo.id,
      modelo_titulo: modelo.titulo,
      corretor_id: currentUsuario.id,
      corretor_nome: currentUsuario.nome || '',
      cliente_nome: dados[modelo.nomeArquivoTag] || '',
      nome_arquivo: resultado.nomeArquivo,
      storage_path: erroUpload ? null : caminho,
      // Guarda todos os dados usados para gerar este PDF — permite que
      // gerente/admin corrijam um erro de digitação depois, sem precisar
      // pedir pro corretor refazer do zero (ver "Editar" no Histórico de
      // Documentos, mais abaixo).
      dados_json: dadosParaHistorico,
    });
    if (erroUpload) console.error('Falha ao arquivar PDF no histórico:', erroUpload);
    if (erroInsert) console.error('Falha ao registrar documento no histórico:', erroInsert);
  } catch (err) {
    console.error('Falha ao registrar documento no histórico:', err);
  }
}

// Corrige um documento já emitido (gerente/admin): regera o PDF com os
// dados atualizados, substitui o arquivo no Storage e atualiza o mesmo
// registro em documentos_gerados (nunca cria um segundo registro).
async function salvarEdicaoDocumentoGerado(modelo, dados, registro) {
  const textoPersonalizado = await obterTextoPersonalizadoModelo(modelo);
  const resultado = await window.gerarPdfDocumento(modelo, dados, textoPersonalizado);
  const pastaCorretor = registro.corretor_id || currentUsuario?.id;
  const novoCaminho = `${pastaCorretor}/${resultado.nomeArquivo}`;

  const { error: erroUpload } = await supabase.storage
    .from(DOCUMENTOS_GERADOS_STORAGE_BUCKET)
    .upload(novoCaminho, resultado.blob, { contentType: 'application/pdf', upsert: true });
  if (erroUpload) throw new Error('Falha ao salvar o PDF corrigido: ' + erroUpload.message);

  // O nome do arquivo muda (leva a data de hoje) — remove o PDF antigo do
  // Storage pra não deixar lixo acumulando, mas só depois do novo já estar
  // salvo com sucesso.
  if (registro.storage_path && registro.storage_path !== novoCaminho) {
    await supabase.storage.from(DOCUMENTOS_GERADOS_STORAGE_BUCKET).remove([registro.storage_path]);
  }

  const dadosParaHistorico = { ...dados };
  (modelo.campos || []).forEach((c) => {
    if (c.tipo === 'imagem' && Array.isArray(dadosParaHistorico[c.tag])) {
      dadosParaHistorico[c.tag] = `[${dadosParaHistorico[c.tag].length} foto(s) anexada(s) — não é possível trocar ao editar, é preciso reanexar]`;
    }
  });

  const { error: erroUpdate } = await supabase.from('documentos_gerados').update({
    dados_json: dadosParaHistorico,
    cliente_nome: dados[modelo.nomeArquivoTag] || '',
    nome_arquivo: resultado.nomeArquivo,
    storage_path: novoCaminho,
    atualizado_em: new Date().toISOString(),
    editado_por_nome: currentUsuario?.nome || '',
  }).eq('id', registro.id);
  if (erroUpdate) throw new Error('Falha ao atualizar o registro no histórico: ' + erroUpdate.message);

  return resultado;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let modelosPersonalizadosSet = new Set();

async function loadGeradorView() {
  if (!pessoasCache.length) await loadPessoas();
  if (!imoveisCache.length) await loadImoveis();
  if (!configSiteDocCache) {
    const { data } = await supabase.from('config_site').select('*').eq('id', 1).maybeSingle();
    configSiteDocCache = data || {};
  }
  if (podeVerFinanceiro) {
    const { data: arquivosStorage } = await supabase.storage.from('site-imagens').list(MODELOS_DOC_STORAGE_PASTA);
    modelosPersonalizadosSet = new Set((arquivosStorage || []).filter((f) => f.name?.endsWith('.txt')).map((f) => f.name.replace(/\.txt$/, '')));
  }

  $('#docModelosGrid').innerHTML = `
    <p class="doc-modelos-ajuda full">${podeVerFinanceiro
      ? 'Escolha um modelo, preencha os dados e gere o documento em PDF, pronto para assinatura. Gerente e administrador podem editar o texto de qualquer modelo em "Editar texto".'
      : 'Escolha um modelo, preencha os dados e gere o documento em PDF, pronto para assinatura. O download fica disponível após gerar.'}</p>
  ` + MODELOS_DOC.map((m) => {
    const personalizado = modelosPersonalizadosSet.has(m.id);
    return `
    <div class="doc-modelo-card">
      <h3>${m.titulo} ${personalizado ? '<span class="doc-modelo-badge">personalizado</span>' : ''}</h3>
      <p>${m.descricao}</p>
      <button class="btn btn-primary" data-action="doc-gerar" data-id="${m.id}">Preencher e gerar (.pdf)</button>
      ${podeVerFinanceiro ? `
        <div class="doc-modelo-actions">
          <button class="btn btn-ghost btn-sm" data-action="doc-editar-modelo" data-id="${m.id}">Editar texto</button>
          ${personalizado ? `<button class="btn btn-ghost btn-sm" data-action="doc-restaurar-modelo" data-id="${m.id}">Restaurar padrão</button>` : ''}
        </div>
      ` : ''}
    </div>
  `;
  }).join('');
}

function editarModeloTextoHtml(modelo, textoAtual) {
  return `
    <h2>Editar texto — ${modelo.titulo}</h2>
    <p class="modal-subtitle">Cada parágrafo/cláusula fica separado por uma linha em branco. Use <code>{tag}</code> para inserir um dado preenchido no formulário (ex: <code>{locador_nome}</code>) e <code>{#tem_fiador}...{/tem_fiador}</code> para trechos condicionais. Cabeçalho, rodapé, identificação da imobiliária, assinaturas, testemunhas e o aviso legal são fixos e não aparecem aqui — vale para todos os corretores a partir de salvar.</p>
    <form class="modal-form" id="editarModeloForm">
      <textarea id="editar-modelo-texto" rows="18" class="full" style="width:100%;font-family:monospace;font-size:12.5px;line-height:1.4;">${escapeHtml(textoAtual)}</textarea>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelEditarModelo">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  `;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#avaliacaoRapidaBtn')) {
    navigateTo('gerador');
    const modelo = MODELOS_DOC.find((m) => m.id === 'parecer_mercadologico');
    if (!modelo) { toast('Modelo de avaliação não encontrado.', true); return; }
    openModal(documentoDocForm(modelo), { wide: true });
    bindDocumentoDocForm(modelo);
  }

  if (e.target.dataset.action === 'doc-gerar') {
    const modelo = MODELOS_DOC.find((m) => m.id === e.target.dataset.id);
    if (!modelo) return;
    openModal(documentoDocForm(modelo), { wide: true });
    bindDocumentoDocForm(modelo);
  }

  if (e.target.dataset.action === 'doc-editar-modelo') {
    if (!podeVerFinanceiro) { toast('Somente gerente e administrador podem editar modelos.', true); return; }
    const modelo = MODELOS_DOC.find((m) => m.id === e.target.dataset.id);
    if (!modelo) return;
    const textoOriginal = e.target.textContent;
    e.target.disabled = true;
    e.target.textContent = 'Carregando...';
    let texto;
    try {
      texto = (await obterTextoPersonalizadoModelo(modelo)) || (window.obterTextoModeloPadrao ? window.obterTextoModeloPadrao(modelo.id) : '');
    } catch (err) {
      toast('Erro ao carregar o texto do modelo: ' + err.message, true);
      e.target.disabled = false;
      e.target.textContent = textoOriginal;
      return;
    }
    e.target.disabled = false;
    e.target.textContent = textoOriginal;
    openModal(editarModeloTextoHtml(modelo, texto), { wide: true });
    $('#cancelEditarModelo').addEventListener('click', closeModal);
    $('#editarModeloForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Salvando...';
      try {
        const novoTexto = $('#editar-modelo-texto').value;
        const blob = new Blob([novoTexto], { type: 'text/plain;charset=utf-8' });
        const { error } = await supabase.storage.from('site-imagens')
          .upload(`${MODELOS_DOC_STORAGE_PASTA}/${modelo.id}.txt`, blob, { upsert: true, contentType: 'text/plain;charset=utf-8' });
        if (error) throw error;
        toast('Texto do modelo salvo. Vale para todos os corretores a partir de agora.');
        closeModal();
        loadGeradorView();
      } catch (err) {
        toast('Erro ao salvar: ' + err.message, true);
        btn.disabled = false;
        btn.textContent = 'Salvar';
      }
    });
  }

  if (e.target.dataset.action === 'doc-restaurar-modelo') {
    if (!podeVerFinanceiro) return;
    const modelo = MODELOS_DOC.find((m) => m.id === e.target.dataset.id);
    if (!modelo) return;
    if (!confirm(`Restaurar o texto padrão de "${modelo.titulo}"? O texto personalizado salvo será removido.`)) return;
    const { error } = await supabase.storage.from('site-imagens').remove([`${MODELOS_DOC_STORAGE_PASTA}/${modelo.id}.txt`]);
    if (error) { toast('Erro ao restaurar: ' + error.message, true); return; }
    toast('Texto restaurado ao padrão.');
    loadGeradorView();
  }
});

// =====================================================================
// APROVAÇÕES — documentação de clientes em processo de aprovação
// (financiamento bancário / loteadora / cartório-registro).
// Editam: admin, gerente e "analista_doc". Corretor vê só leitura dos
// processos dos próprios clientes (regra garantida pela RLS).
// =====================================================================
const APROVACAO_TIPOS = {
  financiamento: 'Financiamento bancário',
  loteadora: 'Aprovação com loteadora',
  incorporadora: 'Aprovação com incorporadora (imóvel na planta)',
  cartorio: 'Cartório / Registro',
};

const APROVACAO_STATUS = [
  ['documentacao_coleta',    'Documentação em coleta (com o corretor)'],
  ['verificacao_cpf',        'Enviado para verificação de CPF/restrição'],
  ['cpf_aprovado',           'CPF aprovado'],
  ['cpf_restricao',          'CPF com restrição (pendência)'],
  ['enviado_instituicao',    'Enviado para correspondente / loteadora'],
  ['em_analise',             'Em análise'],
  ['aprovado',               'Aprovado'],
  ['reprovado',              'Reprovado'],
  ['encaminhado_cartorio',   'Encaminhado para cartório'],
  ['aguardando_assinaturas', 'Aguardando assinaturas'],
  ['concluido',              'Concluído'],
];
const APROVACAO_STATUS_LABEL = Object.fromEntries(APROVACAO_STATUS);
const APROVACAO_STATUS_FINAL = new Set(['concluido', 'reprovado']);

// Dias tolerados em cada etapa antes de marcar o processo como "parado".
const APROVACAO_SLA_DIAS = {
  documentacao_coleta: 10, verificacao_cpf: 3, cpf_aprovado: 5, cpf_restricao: 15,
  enviado_instituicao: 3, em_analise: 15, aprovado: 7, encaminhado_cartorio: 20,
  aguardando_assinaturas: 10,
};

// Ordenação da lista: pendência de CPF primeiro, depois etapas ativas, terminais no fim.
const APROVACAO_STATUS_PRIORIDADE = {
  cpf_restricao: 0,
  documentacao_coleta: 1, verificacao_cpf: 1, enviado_instituicao: 1,
  cpf_aprovado: 2, em_analise: 2, aprovado: 2, encaminhado_cartorio: 2, aguardando_assinaturas: 2,
  reprovado: 3, concluido: 4,
};

const APROVACAO_CATEGORIAS_ARQUIVO = {
  rg_cpf: 'RG e CPF ou CNH',
  comprovante_renda: 'Comprovante de renda',
  comprovante_residencia: 'Comprovante de residência',
  certidao: 'Certidão de estado civil',
  carteira_trabalho: 'Carteira de trabalho',
  autorizacao_pesquisa: 'Autorização de pesquisa (MO)',
  cartinha_cancelamento: 'Cartinha de cancelamento de outro correspondente',
  cci_cohapar: 'CCI Cohapar (se houver)',
  extrato_bancario: 'Extrato bancário',
  contrato_social: 'Contrato social / empresa',
  outro: 'Outro',
};
const APROVACAO_ARQUIVOS_BUCKET = 'aprovacao-arquivos';

// Dica de contexto por categoria, específica pro tipo de renda do cliente —
// mostrada como texto de apoio no seletor de categoria no upload (o
// comprovante de renda pede algo diferente pra CLT x renda informal).
const APROVACAO_DICA_RENDA = {
  clt: { comprovante_renda: '3 últimos holerites' },
  informal: { comprovante_renda: 'cartinha de declaração de renda informal' },
  aposentado: { comprovante_renda: 'extrato de pagamento do benefício (INSS) ou carta de concessão' },
};

// Matriz do que é exigido em cada modalidade de processo — separado por
// tipo de renda do cliente (CLT x Informal) nas modalidades que exigem essa
// distinção. "arquivos" são categorias que o corretor precisa anexar como
// documento; "textos" são informações que não viram arquivo, mas precisam
// ser repassadas/confirmadas com a Daiane mesmo assim (email, telefone,
// PIS, declaração de IR etc.).
const APROVACAO_DOCS_MATRIZ = {
  loteadora: {
    clt: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'carteira_trabalho'],
      textos: ['E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
    informal: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'carteira_trabalho'],
      textos: ['E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
    aposentado: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao'],
      textos: ['E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
  },
  incorporadora: {
    clt: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'carteira_trabalho', 'autorizacao_pesquisa', 'cartinha_cancelamento', 'cci_cohapar'],
      textos: ['Número do PIS', 'E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
    informal: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'carteira_trabalho', 'autorizacao_pesquisa', 'cartinha_cancelamento'],
      textos: ['Número do PIS', 'E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
    aposentado: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'autorizacao_pesquisa', 'cartinha_cancelamento', 'cci_cohapar'],
      textos: ['Número do PIS/NIT (se tiver)', 'E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
  },
  financiamento: {
    clt: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'carteira_trabalho', 'autorizacao_pesquisa', 'cartinha_cancelamento', 'cci_cohapar'],
      textos: ['Número do PIS', 'E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
    informal: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'carteira_trabalho', 'autorizacao_pesquisa', 'cartinha_cancelamento'],
      textos: ['Número do PIS', 'E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
    aposentado: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'comprovante_renda', 'certidao', 'autorizacao_pesquisa', 'cartinha_cancelamento', 'cci_cohapar'],
      textos: ['Número do PIS/NIT (se tiver)', 'E-mail e telefone', 'Telefone recado — nome e parentesco', 'Declaração de Imposto de Renda, se declarar'],
    },
  },
  // Cartório não separa por tipo de renda — mesma exigência pra todo mundo,
  // e vale tanto pro vendedor quanto pro comprador.
  cartorio: {
    padrao: {
      arquivos: ['rg_cpf', 'comprovante_residencia', 'certidao'],
      textos: ['E-mail e telefone'],
    },
  },
};

function obterExigenciasDocumento(tipoProcesso, tipoRenda) {
  const grupo = APROVACAO_DOCS_MATRIZ[tipoProcesso];
  if (!grupo) return { arquivos: [], textos: [] };
  if (tipoProcesso === 'cartorio') return grupo.padrao;
  return grupo[tipoRenda] || null; // null = ainda não escolheu CLT/Informal
}

// Monta as <option> do seletor de categoria de documento, acrescentando a
// dica certa pro comprovante de renda (holerite x cartinha informal)
// conforme o tipo de renda já definido no processo.
function opcoesCategoriaArquivo(tipoRenda) {
  const dica = tipoRenda ? APROVACAO_DICA_RENDA[tipoRenda] : null;
  return Object.entries(APROVACAO_CATEGORIAS_ARQUIVO)
    .map(([k, v]) => `<option value="${k}">${v}${dica?.[k] ? ' — ' + dica[k] : ''}</option>`).join('');
}

let aprovacoesCache = [];
let aprovacoesFiltrosCarregados = false;

function diasParado(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function aprovacaoAlerta(a) {
  if (APROVACAO_STATUS_FINAL.has(a.status)) return null;
  const limite = APROVACAO_SLA_DIAS[a.status];
  if (!limite) return null;
  const dias = diasParado(a.atualizado_em);
  if (dias > limite) return { nivel: 'atraso', dias };
  if (dias >= limite - Math.max(2, Math.round(limite * 0.3))) return { nivel: 'prazo', dias };
  return null;
}

async function loadAprovacoes() {
  $('#newAprovacaoBtn').hidden = !podeVerAprovacoes;
  $('#btnInstituicoes').hidden = !podeVerAprovacoes;
  $('#newConsultaRapidaBtn').hidden = podeVerAprovacoes || currentUsuario?.cargo !== 'corretor';
  $('#newProcessoCorretorBtn').hidden = podeVerAprovacoes || currentUsuario?.cargo !== 'corretor';
  $('#aprovacoesSubtitulo').textContent = podeVerAprovacoes
    ? 'Documentação de clientes em processo de aprovação'
    : 'Acompanhamento dos processos dos seus clientes (somente leitura)';

  if (!aprovacoesFiltrosCarregados) {
    $('#aprovacoesFiltroStatus').innerHTML = '<option value="">Todos os status</option>' +
      APROVACAO_STATUS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    if (podeVerAprovacoes) {
      const { data: corretores } = await supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome');
      const sel = $('#aprovacoesFiltroCorretor');
      sel.hidden = false;
      sel.innerHTML = '<option value="">Todos os corretores</option>' +
        (corretores || []).map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('');
    }
    aprovacoesFiltrosCarregados = true;
  }

  const wrap = $('#aprovacoesCards');
  wrap.innerHTML = '<p class="empty-state">Carregando...</p>';
  const { data, error } = await supabase
    .from('aprovacoes')
    .select(`*,
      comprador:pessoas!aprovacoes_comprador_id_fkey(nome, telefone, cpf_cnpj),
      comprador2:pessoas!aprovacoes_comprador2_id_fkey(nome, telefone, cpf_cnpj),
      vendedor:pessoas!aprovacoes_vendedor_id_fkey(nome),
      imovel:imoveis(titulo, bairro, cidade),
      corretor:usuarios!aprovacoes_corretor_id_fkey(nome),
      analista:usuarios!aprovacoes_analista_id_fkey(nome),
      instituicao:instituicoes(nome, tipo)`)
    .order('atualizado_em', { ascending: false });

  if (error) { wrap.innerHTML = '<p class="empty-state">Erro ao carregar aprovações.</p>'; console.error(error); return; }

  // Busca as categorias de documento já enviadas em cada processo, pra saber
  // o que ainda falta (o card mostra um selo com a pendência).
  const idsAprovacoes = (data || []).map((a) => a.id);
  const categoriasPorAprovacao = {};
  if (idsAprovacoes.length) {
    const { data: arquivosTodos } = await supabase.from('aprovacao_arquivos')
      .select('aprovacao_id, categoria').in('aprovacao_id', idsAprovacoes);
    (arquivosTodos || []).forEach((x) => {
      (categoriasPorAprovacao[x.aprovacao_id] = categoriasPorAprovacao[x.aprovacao_id] || new Set()).add(x.categoria);
    });
  }
  (data || []).forEach((a) => { a.categoriasPresentes = categoriasPorAprovacao[a.id] || new Set(); });

  aprovacoesCache = (data || []).slice().sort((a, b) => {
    const pa = APROVACAO_STATUS_PRIORIDADE[a.status] ?? 2;
    const pb = APROVACAO_STATUS_PRIORIDADE[b.status] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.atualizado_em) - new Date(a.atualizado_em);
  });
  renderAprovacoesCards();
}

function renderAprovacoesCards() {
  const wrap = $('#aprovacoesCards');
  if (!wrap) return;
  const termo = semAcento(($('#aprovacoesSearch')?.value || '').trim());
  const fTipo = $('#aprovacoesFiltroTipo')?.value || '';
  const fStatus = $('#aprovacoesFiltroStatus')?.value || '';
  const fCorretor = $('#aprovacoesFiltroCorretor')?.value || '';
  const soAtrasadas = $('#aprovacoesFiltroAtrasadas')?.checked;

  let lista = aprovacoesCache;
  if (fTipo) lista = lista.filter((a) => a.tipo_processo === fTipo);
  if (fStatus) lista = lista.filter((a) => a.status === fStatus);
  if (fCorretor) lista = lista.filter((a) => a.corretor_id === fCorretor);
  if (soAtrasadas) lista = lista.filter((a) => aprovacaoAlerta(a)?.nivel === 'atraso');
  if (termo) lista = lista.filter((a) => semAcento([
    a.comprador?.nome, a.vendedor?.nome, a.imovel?.titulo, a.instituicao?.nome, a.corretor?.nome,
  ].filter(Boolean).join(' ')).includes(termo));

  if (!lista.length) {
    wrap.innerHTML = `<p class="empty-state">${aprovacoesCache.length ? 'Nenhum processo encontrado para esse filtro.' : 'Nenhum processo de aprovação cadastrado ainda.'}</p>`;
    return;
  }

  const rotuloAcao = podeVerAprovacoes ? 'Abrir' : 'Ver';
  wrap.innerHTML = lista.map((a) => {
    const alerta = aprovacaoAlerta(a);
    const selo = alerta
      ? `<span class="aprovacao-badge-${alerta.nivel === 'atraso' ? 'atraso' : 'prazo'}">⏰ parado há ${alerta.dias} dia${alerta.dias === 1 ? '' : 's'}</span>`
      : '';
    const loc = [a.imovel?.bairro, a.imovel?.cidade].filter(Boolean).join(' — ');
    const badges = [`<span class="badge-mini">${APROVACAO_TIPOS[a.tipo_processo] || a.tipo_processo}</span>`];
    const TIPO_RENDA_LABEL = { clt: 'Cliente CLT', informal: 'Renda informal', aposentado: 'Aposentado/pensionista' };
    if (a.tipo_processo !== 'cartorio' && a.tipo_renda) badges.push(`<span class="badge-mini">${TIPO_RENDA_LABEL[a.tipo_renda] || a.tipo_renda}</span>`);
    if (a.instituicao?.nome) badges.push(`<span class="badge-mini">${escapeHtml(a.instituicao.nome)}</span>`);
    if (a.tipo_processo === 'cartorio' && a.data_prevista_assinatura) {
      badges.push(`<span class="badge-mini">✍️ ${new Date(a.data_prevista_assinatura + 'T00:00:00').toLocaleDateString('pt-BR')}</span>`);
    }
    const exigencias = obterExigenciasDocumento(a.tipo_processo, a.tipo_renda);
    let seloDocumentos = '';
    if (exigencias === null) {
      seloDocumentos = `<span class="aprovacao-badge-prazo">⚠️ defina o tipo de renda do cliente (CLT / informal) pra ver os documentos exigidos</span>`;
    } else if (exigencias.arquivos.length) {
      const dispensadas = new Set(a.categorias_dispensadas || []);
      const faltando = exigencias.arquivos.filter((c) => !a.categoriasPresentes?.has(c) && !dispensadas.has(c));
      if (!faltando.length) {
        seloDocumentos = `<span class="aprovacao-badge-ok">📎 documentação completa</span>`;
      } else if (podeVerAprovacoes) {
        // Chip clicável — Daiane/admin/gerente podem marcar um item como
        // dispensado (corretor não conseguiu com o comprador, mas o
        // processo pode seguir), sem precisar de arquivo anexado.
        seloDocumentos = `<span class="aprovacao-badge-prazo">📎 falta:</span> ` + faltando.map((c) => `<button type="button" class="badge-mini badge-clicavel" data-action="aprovacao-dispensar-categoria" data-id="${a.id}" data-categoria="${c}" title="Clique pra marcar como dispensado (concluído sem anexo)">${APROVACAO_CATEGORIAS_ARQUIVO[c] || c} ✕</button>`).join(' ');
      } else {
        seloDocumentos = `<span class="aprovacao-badge-prazo" title="${faltando.map((c) => APROVACAO_CATEGORIAS_ARQUIVO[c] || c).join(', ')}">📎 falta: ${faltando.map((c) => APROVACAO_CATEGORIAS_ARQUIVO[c] || c).join(', ')}</span>`;
      }
    }
    const seloTextos = exigencias?.textos?.length
      ? `<span class="badge-mini" title="Não vira arquivo — confirme com a Daiane">📞 confirmar: ${exigencias.textos.join(', ')}</span>`
      : '';
    return `
      <article class="imovel-card">
        <div class="imovel-card-body" style="padding-left:2px;">
          <div class="imovel-card-top">
            <div class="imovel-card-heading">
              <span class="imovel-card-codigo">${APROVACAO_TIPOS[a.tipo_processo] || a.tipo_processo}</span>
              <h3 class="imovel-card-titulo">${escapeHtml(a.comprador?.nome || 'Cliente não vinculado')}</h3>
              <p class="imovel-card-loc">${a.imovel?.titulo ? escapeHtml(a.imovel.titulo) + (loc ? ' · ' + loc : '') : (loc || 'Sem imóvel vinculado')}</p>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0;">
              ${statusPill(a.status)}
              ${selo}
            </div>
          </div>
          <div class="imovel-card-badges">${badges.join('')}</div>
          <div class="imovel-card-badges">${seloDocumentos}${seloTextos}</div>
          <div class="imovel-card-footer">
            <div class="imovel-card-precowrap">
              <span class="imovel-card-meta">Corretor: ${escapeHtml(a.corretor?.nome || '—')} · Analista: ${escapeHtml(a.analista?.nome || '—')}</span>
              <span class="imovel-card-meta">${APROVACAO_STATUS_LABEL[a.status] || a.status} · atualizado ${dateTime(a.atualizado_em)}</span>
            </div>
            <div class="imovel-card-actions">
              <button class="btn btn-ghost btn-sm" data-action="aprovacao-abrir" data-id="${a.id}">${rotuloAcao}</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

['#aprovacoesSearch', '#aprovacoesFiltroTipo', '#aprovacoesFiltroStatus', '#aprovacoesFiltroCorretor', '#aprovacoesFiltroAtrasadas'].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('input', renderAprovacoesCards);
  el.addEventListener('change', renderAprovacoesCards);
});

async function aprovacaoFormDados() {
  const [{ data: pessoas }, { data: imoveis }, { data: corretores }, { data: instituicoes }] = await Promise.all([
    supabase.from('pessoas').select('id,nome').order('nome'),
    supabase.from('imoveis').select('id,titulo').order('titulo'),
    supabase.from('usuarios').select('id,nome').eq('ativo', true).order('nome'),
    supabase.from('instituicoes').select('id,nome,tipo').eq('ativo', true).order('nome'),
  ]);
  return { pessoas: pessoas || [], imoveis: imoveis || [], corretores: corretores || [], instituicoes: instituicoes || [] };
}

function aprovacaoForm(a = {}, dados) {
  const opt = (arr, sel, lab = 'nome') => arr.map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${escapeHtml(o[lab] || '')}</option>`).join('');
  const instOpts = dados.instituicoes
    .map((i) => `<option value="${i.id}" ${i.id === a.instituicao_id ? 'selected' : ''}>${escapeHtml(i.nome)} · ${APROVACAO_TIPOS[i.tipo] || i.tipo}</option>`).join('');
  return `
    <h2 style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <span>${a.id ? 'Editar processo de aprovação' : 'Novo processo de aprovação'}</span>
      ${a.id ? `<button type="button" class="btn btn-ghost btn-sm" id="ap-excluir-processo" data-id="${a.id}" style="color:#e0555f; font-weight:400; font-size:.8rem;">🗑️ Excluir processo</button>` : ''}
    </h2>
    <form class="modal-form" id="aprovacaoForm">
      <input type="hidden" id="ap-id" value="${a.id || ''}">
      <div class="form-row"><label>Tipo de processo</label>
        <select id="ap-tipo" required>
          <option value="">Selecione...</option>
          ${Object.entries(APROVACAO_TIPOS).map(([k, v]) => `<option value="${k}" ${a.tipo_processo === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="form-row" id="ap-tipo-renda-wrap" ${a.tipo_processo === 'cartorio' ? 'hidden' : ''}><label>Tipo de renda do cliente</label>
        <select id="ap-tipo-renda">
          <option value="">— não definido —</option>
          <option value="clt" ${a.tipo_renda === 'clt' ? 'selected' : ''}>CLT (carteira assinada)</option>
          <option value="informal" ${a.tipo_renda === 'informal' ? 'selected' : ''}>Renda informal / autônomo</option>
          <option value="aposentado" ${a.tipo_renda === 'aposentado' ? 'selected' : ''}>Aposentado / pensionista</option>
        </select>
      </div>
      <div class="form-row"><label>Status ${a.id ? 'atual' : 'inicial'}</label>
        <select id="ap-status">
          ${APROVACAO_STATUS.map(([k, v]) => `<option value="${k}" ${(a.status || 'documentacao_coleta') === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Cliente (comprador) — Proponente 1</label>
        <select id="ap-comprador" required>
          <option value="">Selecione...</option>
          <option value="__novo__">➕ Cadastrar cliente novo…</option>
          ${opt(dados.pessoas, a.comprador_id)}
        </select>
      </div>
      <div class="form-row full"><label>Proponente 2 (opcional — cônjuge, coobrigado...)</label>
        <select id="ap-comprador2">
          <option value="">— nenhum —</option>
          ${opt(dados.pessoas, a.comprador2_id)}
        </select>
      </div>
      <div class="form-row full" id="ap-novo-cliente-wrap" hidden>
        <div class="proprietario-novo">
          <p style="font-size:.78rem;color:var(--gray-text);margin:0 0 8px;">Cadastra o cliente em Pessoas na hora (papel "comprador"). Se já existir alguém com o mesmo nome e telefone, o sistema reaproveita.</p>
          <div class="proprietario-novo-grid">
            <input id="ap-nc-nome" placeholder="Nome completo *">
            <input id="ap-nc-telefone" placeholder="Telefone / WhatsApp *">
            <input id="ap-nc-cpf" placeholder="CPF / CNPJ (opcional)">
            <input id="ap-nc-email" placeholder="E-mail (opcional)">
          </div>
        </div>
      </div>
      <div class="form-row full" id="ap-vendedor-wrap">
        <label>Vendedor vinculado (cartório / registro)</label>
        <select id="ap-vendedor">
          <option value="">Selecione...</option>
          <option value="__novo__">➕ Cadastrar vendedor novo…</option>
          ${opt(dados.pessoas, a.vendedor_id)}
        </select>
        <div id="ap-nv-wrap" hidden style="margin-top:8px;">
          <div class="proprietario-novo">
            <p style="font-size:.78rem;color:var(--gray-text);margin:0 0 8px;">Cadastra o vendedor em Pessoas na hora (papel "vendedor"). Se já existir alguém com o mesmo nome e telefone, o sistema reaproveita.</p>
            <div class="proprietario-novo-grid">
              <input id="ap-nv-nome" placeholder="Nome completo *">
              <input id="ap-nv-telefone" placeholder="Telefone / WhatsApp *">
              <input id="ap-nv-cpf" placeholder="CPF / CNPJ (opcional)">
              <input id="ap-nv-email" placeholder="E-mail (opcional)">
            </div>
          </div>
        </div>
      </div>
      <div class="form-row full"><label>Imóvel / terreno vinculado</label>
        <select id="ap-imovel"><option value="">Selecione...</option>${opt(dados.imoveis, a.imovel_id, 'titulo')}</select>
      </div>
      <div class="form-row"><label>Corretor responsável pela documentação</label>
        <select id="ap-corretor"><option value="">Selecione...</option>${opt(dados.corretores, a.corretor_id)}</select>
      </div>
      <div class="form-row"><label>Analista responsável</label>
        <select id="ap-analista"><option value="">Selecione...</option>${opt(dados.corretores, a.analista_id || currentUsuario?.id)}</select>
      </div>
      <div class="form-row full"><label>Instituição (correspondente bancária / loteadora / cartório)</label>
        <select id="ap-instituicao"><option value="">— não definida —</option>${instOpts}</select>
      </div>
      <div class="form-row full" id="ap-assinatura-wrap"><label>Data prevista de assinatura</label>
        <input type="date" id="ap-assinatura" value="${a.data_prevista_assinatura || ''}">
      </div>
      <div class="form-row full"><label>Observações / pendências</label>
        <textarea id="ap-obs" rows="2">${a.observacoes ? escapeHtml(a.observacoes) : ''}</textarea>
      </div>
      ${a.id ? `
      <div class="form-row full"><label>Observação da mudança de status <span style="font-weight:400;color:var(--gray-text);">— só entra no histórico se você trocar o status</span></label>
        <input id="ap-nota" placeholder="Ex: nome no Serasa, cliente regulariza até dia 10">
      </div>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelAprovacao">Cancelar</button>
        <button type="submit" class="btn btn-primary">${a.id ? 'Salvar' : 'Criar processo'}</button>
      </div>
    </form>
    ${a.id ? `
    <h3 style="margin-top:20px;">Histórico de status</h3>
    <ul class="aprovacao-historico" id="aprovacaoHistorico"><li>Carregando...</li></ul>

    <h3 style="margin-top:8px;">Documentos anexados</h3>
    <div id="aprovacaoArquivosLista" class="contrato-arquivos-lista"><p class="dash-vazio">Carregando...</p></div>
    ${(a.categorias_dispensadas || []).length ? `
    <div style="margin:10px 0;">
      <span class="dash-linha-sub">Dispensados (marcados como concluído sem anexo):</span><br>
      ${a.categorias_dispensadas.map((c) => `<button type="button" class="badge-mini badge-clicavel" data-action="aprovacao-restaurar-categoria" data-id="${a.id}" data-categoria="${c}" title="Clique pra voltar a exigir este documento" style="background:rgba(64,180,120,.18); color:#2fa86a; margin:4px 4px 0 0;">${APROVACAO_CATEGORIAS_ARQUIVO[c] || c} ↺</button>`).join('')}
    </div>` : ''}
    <div class="contrato-arquivos-upload">
      <select id="ap-arq-categoria">
        ${opcoesCategoriaArquivo(a.tipo_renda)}
      </select>
      ${a.comprador2_id ? `
      <select id="ap-arq-titular">
        <option value="proponente1">Proponente 1${a.comprador?.nome ? ' — ' + escapeHtml(a.comprador.nome) : ''}</option>
        <option value="proponente2">Proponente 2${a.comprador2?.nome ? ' — ' + escapeHtml(a.comprador2.nome) : ''}</option>
      </select>` : `<input type="hidden" id="ap-arq-titular" value="proponente1">`}
      <input type="text" id="ap-arq-descricao" placeholder="Referente a (opcional) — ex: 2ª via do RG..." style="min-width:220px;">
      <input type="file" id="ap-arq-file">
      <button type="button" class="btn btn-ghost btn-sm" id="ap-arq-upload">Enviar arquivo</button>
    </div>

    <h3 style="margin-top:20px;">Consulta de CPF</h3>
    <div id="aprovacaoCpfLista" class="contrato-arquivos-lista"><p class="dash-vazio">Carregando...</p></div>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;">
      ${a.comprador?.cpf_cnpj ? `<button type="button" class="btn btn-ghost btn-sm" data-action="cpf-consultar-proponente" data-cpf="${escapeHtml(a.comprador.cpf_cnpj)}" data-nome="${escapeHtml(a.comprador.nome || 'Proponente 1')}" data-id="${a.id}">📨 Consultar CPF — ${escapeHtml(a.comprador.nome || 'Proponente 1')}</button>` : ''}
      ${a.comprador2?.cpf_cnpj ? `<button type="button" class="btn btn-ghost btn-sm" data-action="cpf-consultar-proponente" data-cpf="${escapeHtml(a.comprador2.cpf_cnpj)}" data-nome="${escapeHtml(a.comprador2.nome || 'Proponente 2')}" data-id="${a.id}">📨 Consultar CPF — ${escapeHtml(a.comprador2.nome || 'Proponente 2')}</button>` : ''}
    </div>
    <p class="dash-linha-sub" style="margin:10px 0 4px;">Outra pessoa — digite manualmente:</p>
    <div class="contrato-arquivos-upload">
      <input type="text" id="ap-cpf-numero" placeholder="CPF do titular (ex: 000.000.000-00)" style="max-width:220px;">
      <input type="text" id="ap-cpf-nome" placeholder="Nome (cliente, cônjuge...) — opcional" style="max-width:220px;">
      <button type="button" class="btn btn-ghost btn-sm" id="ap-cpf-enviar">Adicionar pedido</button>
    </div>` : ''}
  `;
}

function aprovacaoAtualizarCampos() {
  const ehCartorio = $('#ap-tipo').value === 'cartorio';
  $('#ap-vendedor-wrap').hidden = !ehCartorio;
  $('#ap-assinatura-wrap').hidden = !ehCartorio;
  if ($('#ap-tipo-renda-wrap')) $('#ap-tipo-renda-wrap').hidden = ehCartorio;
}

function aprovacaoToggleNovasPessoas() {
  $('#ap-novo-cliente-wrap').hidden = $('#ap-comprador').value !== '__novo__';
  $('#ap-nv-wrap').hidden = $('#ap-vendedor').value !== '__novo__';
}

// Resolve comprador/vendedor quando a analista escolhe "Cadastrar ... novo":
// reaproveita a pessoa se já existir (mesmo nome + últimos 8 dígitos do telefone),
// senão cria em Pessoas com o papel indicado. Retorna o id, ou null em erro.
// `prefixo` = 'ap-nc' (comprador) ou 'ap-nv' (vendedor).
async function resolverPessoaNovaAprovacao(prefixo, papel, rotulo) {
  const nome = $(`#${prefixo}-nome`).value.trim();
  const telefone = $(`#${prefixo}-telefone`).value.trim();
  const cpf = $(`#${prefixo}-cpf`).value.trim() || null;
  const email = $(`#${prefixo}-email`).value.trim() || null;
  if (!nome || !telefone) { toast(`Preencha nome e telefone do ${rotulo} novo.`, true); return null; }

  const foneKey = telefone.replace(/\D/g, '').slice(-8);
  const { data: existentes } = await supabase.from('pessoas').select('id, telefone, papeis').ilike('nome', nome);
  const encontrada = (existentes || []).find((p) => (p.telefone || '').replace(/\D/g, '').slice(-8) === foneKey);
  if (encontrada) {
    if (!(encontrada.papeis || []).includes(papel)) {
      await supabase.from('pessoas').update({ papeis: [...(encontrada.papeis || []), papel] }).eq('id', encontrada.id);
    }
    return encontrada.id;
  }

  const { data: nova, error } = await supabase.from('pessoas')
    .insert({
      nome, telefone, cpf_cnpj: cpf, email,
      tipo_pessoa: 'fisica', papeis: [papel],
      corretor_responsavel_id: $('#ap-corretor').value || null,
      origem_cadastro: 'aprovacao', // não entra na fila da Oferta Ativa (cliente já em negócio)
    })
    .select('id').single();
  if (error) {
    toast(error.code === '23505'
      ? 'Já existe uma pessoa com esse telefone, e-mail ou CPF. Peça para vincular o cadastro existente.'
      : `Erro ao cadastrar o ${rotulo}: ` + error.message, true);
    return null;
  }
  return nova.id;
}

function bindAprovacaoForm() {
  $('#cancelAprovacao').addEventListener('click', closeModal);
  $('#ap-tipo').addEventListener('change', aprovacaoAtualizarCampos);
  $('#ap-comprador').addEventListener('change', aprovacaoToggleNovasPessoas);
  $('#ap-vendedor').addEventListener('change', aprovacaoToggleNovasPessoas);
  aprovacaoAtualizarCampos();
  aprovacaoToggleNovasPessoas();

  const id = $('#ap-id').value;
  if (id) { carregarHistoricoAprovacao(id); carregarArquivosAprovacao(id); carregarCpfSolicitacoes(id); }

  $('#aprovacaoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const idAtual = $('#ap-id').value;
    const tipo = $('#ap-tipo').value;
    if (!tipo) { toast('Escolha o tipo de processo.', true); return; }
    if (!$('#ap-comprador').value) { toast('Selecione o cliente (comprador).', true); return; }

    btn.disabled = true; btn.textContent = 'Salvando...';
    const restaurarBotao = () => { btn.disabled = false; btn.textContent = idAtual ? 'Salvar' : 'Criar processo'; };

    let compradorId = $('#ap-comprador').value;
    if (compradorId === '__novo__') {
      compradorId = await resolverPessoaNovaAprovacao('ap-nc', 'comprador', 'cliente');
      if (!compradorId) { restaurarBotao(); return; }
    }
    const comprador2Id = $('#ap-comprador2')?.value || null;

    let vendedorId = tipo === 'cartorio' ? ($('#ap-vendedor').value || null) : null;
    if (vendedorId === '__novo__') {
      vendedorId = await resolverPessoaNovaAprovacao('ap-nv', 'vendedor', 'vendedor');
      if (!vendedorId) { restaurarBotao(); return; }
    }

    const payload = {
      tipo_processo: tipo,
      tipo_renda: tipo === 'cartorio' ? null : ($('#ap-tipo-renda')?.value || null),
      status: $('#ap-status').value,
      comprador_id: compradorId,
      comprador2_id: comprador2Id,
      vendedor_id: vendedorId,
      imovel_id: $('#ap-imovel').value || null,
      corretor_id: $('#ap-corretor').value || null,
      analista_id: $('#ap-analista').value || null,
      instituicao_id: $('#ap-instituicao').value || null,
      data_prevista_assinatura: tipo === 'cartorio' ? ($('#ap-assinatura').value || null) : null,
      observacoes: $('#ap-obs').value.trim() || null,
      nota_transicao: $('#ap-nota') ? ($('#ap-nota').value.trim() || null) : null,
    };

    let error;
    if (idAtual) {
      ({ error } = await supabase.from('aprovacoes').update(payload).eq('id', idAtual));
    } else {
      payload.criado_por = currentUsuario?.id || null;
      ({ error } = await supabase.from('aprovacoes').insert(payload));
    }
    btn.disabled = false; btn.textContent = idAtual ? 'Salvar' : 'Criar processo';
    if (error) { toast('Erro ao salvar: ' + error.message, true); console.error(error); return; }
    toast('Processo salvo.');
    closeModal();
    loadAprovacoes();
  });
}

async function carregarHistoricoAprovacao(id) {
  const ul = $('#aprovacaoHistorico');
  if (!ul) return;
  const { data, error } = await supabase.from('aprovacao_historico')
    .select('*').eq('aprovacao_id', id).order('criado_em', { ascending: false });
  if (error) { ul.innerHTML = '<li>Erro ao carregar histórico.</li>'; console.error(error); return; }
  if (!data.length) { ul.innerHTML = '<li>Sem mudanças de status registradas ainda.</li>'; return; }
  ul.innerHTML = data.map((h) => `
    <li>
      <b>${APROVACAO_STATUS_LABEL[h.status_novo] || h.status_novo}</b>
      ${h.status_anterior ? `— antes: ${APROVACAO_STATUS_LABEL[h.status_anterior] || h.status_anterior}` : '— abertura do processo'}
      <span class="dash-linha-sub"> · ${dateTime(h.criado_em)} · ${escapeHtml(h.usuario_nome || '—')}</span>
      ${h.observacao ? `<span class="hist-obs">“${escapeHtml(h.observacao)}”</span>` : ''}
    </li>
  `).join('');
}

async function carregarArquivosAprovacao(id) {
  const wrap = $('#aprovacaoArquivosLista');
  if (!wrap) return;
  const { data, error } = await supabase.from('aprovacao_arquivos')
    .select('*, usuarios(nome)').eq('aprovacao_id', id).order('criado_em', { ascending: false });
  if (error) { wrap.innerHTML = '<p class="dash-vazio">Erro ao carregar documentos.</p>'; console.error(error); return; }
  if (!data.length) { wrap.innerHTML = '<p class="dash-vazio">Nenhum documento anexado ainda.</p>'; return; }
  const porCat = {};
  data.forEach((x) => { (porCat[x.categoria] = porCat[x.categoria] || []).push(x); });
  const temMaisDeUmTitular = new Set(data.map((x) => x.titular)).size > 1;
  const TITULAR_LABEL = { proponente1: 'Proponente 1', proponente2: 'Proponente 2' };
  const botaoBaixarTodos = data.length > 1
    ? `<button type="button" class="btn btn-ghost btn-sm" id="ap-arq-baixar-todos" data-id="${id}" style="margin-bottom:10px;">📦 Baixar todos (.zip)</button>`
    : '';
  wrap.innerHTML = botaoBaixarTodos + Object.entries(porCat).map(([cat, arquivos]) => `
    <div class="dash-bucket-titulo">${APROVACAO_CATEGORIAS_ARQUIVO[cat] || cat}</div>
    ${arquivos.map((x) => `
      <div class="contrato-arquivo-item">
        <div class="contrato-arquivo-info">
          <span class="contrato-arquivo-nome">${escapeHtml(x.nome_arquivo)}${temMaisDeUmTitular ? ` <span class="badge-mini">${TITULAR_LABEL[x.titular] || x.titular}</span>` : ''}</span>
          ${x.descricao ? `<span class="dash-linha-sub" style="font-weight:600;">Referente a: ${escapeHtml(x.descricao)}</span>` : ''}
          <span class="dash-linha-sub">${x.usuarios?.nome ? 'enviado por ' + escapeHtml(x.usuarios.nome) + ' · ' : ''}${dateTime(x.criado_em)}</span>
        </div>
        <div class="contrato-arquivo-acoes">
          <button type="button" class="btn btn-ghost btn-sm" data-action="aprovacao-arquivo-baixar" data-path="${escapeHtml(x.storage_path)}" data-nome="${escapeHtml(x.nome_arquivo)}">Baixar</button>
          ${podeVerAprovacoes ? `<button type="button" class="tarefa-excluir" data-action="aprovacao-arquivo-excluir" data-id="${x.id}" data-path="${escapeHtml(x.storage_path)}" title="Excluir">✕</button>` : ''}
        </div>
      </div>
    `).join('')}
  `).join('');
}

// Baixa todos os documentos de um processo de aprovação num único .zip —
// junta RG, comprovante de renda etc. num arquivo só, pronto pra anexar
// no e-mail da construtora ou mandar pro WhatsApp do correspondente bancário.
async function baixarTodosArquivosAprovacao(aprovacaoId, btn) {
  const textoOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = 'Preparando .zip...';
  try {
    const { data: arquivos, error } = await supabase.from('aprovacao_arquivos')
      .select('*').eq('aprovacao_id', aprovacaoId).order('categoria');
    if (error || !arquivos?.length) throw new Error(error?.message || 'Nenhum arquivo encontrado.');

    const zip = new JSZip();
    const nomesUsados = {};
    for (const arq of arquivos) {
      const { data: signed, error: erroSigned } = await supabase.storage
        .from(APROVACAO_ARQUIVOS_BUCKET).createSignedUrl(arq.storage_path, 60);
      if (erroSigned || !signed?.signedUrl) continue;
      const resp = await fetch(signed.signedUrl);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const categoria = (APROVACAO_CATEGORIAS_ARQUIVO[arq.categoria] || arq.categoria).replace(/[\\/]/g, '-').trim();
      let nomeArquivo = `${categoria} - ${arq.nome_arquivo || 'arquivo'}`;
      const chave = nomeArquivo;
      if (nomesUsados[chave]) {
        nomesUsados[chave] += 1;
        const partes = nomeArquivo.split('.');
        const ext = partes.length > 1 ? '.' + partes.pop() : '';
        nomeArquivo = `${partes.join('.')} (${nomesUsados[chave]})${ext}`;
      } else {
        nomesUsados[chave] = 1;
      }
      zip.file(nomeArquivo, blob);
    }

    const conteudoZip = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(conteudoZip);
    const link = document.createElement('a');
    link.href = url;
    link.download = `documentos-aprovacao-${aprovacaoId.slice(0, 8)}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Zip baixado com sucesso.');
  } catch (e) {
    toast('Não foi possível gerar o zip: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = textoOriginal;
  }
}

document.addEventListener('click', async (e) => {
  const btnRestaurar = e.target.closest('[data-action="aprovacao-restaurar-categoria"]');
  if (!btnRestaurar) return;
  const categoria = btnRestaurar.dataset.categoria;
  const aprovacaoId = btnRestaurar.dataset.id;
  btnRestaurar.disabled = true;
  const { data: atual } = await supabase.from('aprovacoes').select('categorias_dispensadas').eq('id', aprovacaoId).single();
  const novaLista = (atual?.categorias_dispensadas || []).filter((c) => c !== categoria);
  const { error } = await supabase.from('aprovacoes').update({ categorias_dispensadas: novaLista }).eq('id', aprovacaoId);
  if (error) { toast('Erro ao restaurar: ' + error.message, true); btnRestaurar.disabled = false; return; }
  toast('Exigência restaurada.');
  const dados = await aprovacaoFormDados();
  const { data: a } = await supabase.from('aprovacoes')
    .select('*, comprador:pessoas!aprovacoes_comprador_id_fkey(nome, cpf_cnpj), comprador2:pessoas!aprovacoes_comprador2_id_fkey(nome, cpf_cnpj)')
    .eq('id', aprovacaoId).single();
  if (a) { openModal(aprovacaoForm(a, dados)); bindAprovacaoForm(); }
});

// Marca uma categoria de documento como dispensada (concluído sem anexo) —
// só quem gerencia aprovações vê esse botão (o chip só é renderizado nesse
// caso), mas a RLS no banco também trava por segurança.
document.addEventListener('click', async (e) => {
  const btnDispensar = e.target.closest('[data-action="aprovacao-dispensar-categoria"]');
  if (!btnDispensar) return;
  const categoria = btnDispensar.dataset.categoria;
  const rotulo = APROVACAO_CATEGORIAS_ARQUIVO[categoria] || categoria;
  if (!confirm(`Marcar "${rotulo}" como dispensado (concluído sem anexo) neste processo?`)) return;
  btnDispensar.disabled = true;
  const aprovacaoId = btnDispensar.dataset.id;
  const atual = aprovacoesCache.find((a) => a.id === aprovacaoId);
  const novaLista = Array.from(new Set([...(atual?.categorias_dispensadas || []), categoria]));
  const { error } = await supabase.from('aprovacoes').update({ categorias_dispensadas: novaLista }).eq('id', aprovacaoId);
  if (error) { toast('Erro ao dispensar: ' + error.message, true); btnDispensar.disabled = false; return; }
  toast(`"${rotulo}" marcado como dispensado.`);
  loadAprovacoes();
});

document.addEventListener('click', (e) => {
  const btnZip = e.target.closest('#ap-arq-baixar-todos');
  if (btnZip) baixarTodosArquivosAprovacao(btnZip.dataset.id, btnZip);
});

// ---- Consulta de CPF: corretor digita o número, Daiane marca quando consultar ----
function formatarCpfMascara(v) {
  const d = (v || '').replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

async function carregarCpfSolicitacoes(aprovacaoId) {
  const wrap = $('#aprovacaoCpfLista');
  if (!wrap) return;
  const { data, error } = await supabase.from('aprovacao_cpf_solicitacoes')
    .select('*, solicitante:usuarios!aprovacao_cpf_solicitacoes_solicitado_por_fkey(nome)')
    .eq('aprovacao_id', aprovacaoId).order('criado_em', { ascending: false });
  if (error) { wrap.innerHTML = '<p class="dash-vazio">Erro ao carregar solicitações.</p>'; console.error(error); return; }
  if (!data.length) { wrap.innerHTML = '<p class="dash-vazio">Nenhuma consulta solicitada ainda.</p>'; return; }
  wrap.innerHTML = data.map((s) => `
    <div class="contrato-arquivo-item">
      <div class="contrato-arquivo-info">
        <span class="contrato-arquivo-nome">${escapeHtml(s.cpf)}${s.nome_titular ? ' — ' + escapeHtml(s.nome_titular) : ''}</span>
        <span class="dash-linha-sub">
          ${s.status === 'consultado' ? `✅ Consultado${s.resultado ? ': ' + escapeHtml(s.resultado) : ''}` : '⏳ Aguardando consulta'}
          ${s.solicitante?.nome ? ' · pedido por ' + escapeHtml(s.solicitante.nome) : ''} · ${dateTime(s.criado_em)}
        </span>
      </div>
      ${podeVerAprovacoes && s.status === 'pendente' ? `<div class="contrato-arquivo-acoes"><button type="button" class="btn btn-ghost btn-sm" data-action="cpf-marcar-consultado" data-id="${s.id}">Marcar consultado</button></div>` : ''}
    </div>
  `).join('');
}

document.addEventListener('click', async (e) => {
  const btnEnviarCpf = e.target.closest('#ap-cpf-enviar');
  if (!btnEnviarCpf) return;
  const idInput = document.getElementById('ap-id');
  const id = idInput ? idInput.value : null;
  const cpfInput = $('#ap-cpf-numero');
  const nomeInput = $('#ap-cpf-nome');
  const cpf = (cpfInput?.value || '').replace(/\D/g, '');
  if (!id) { toast('Não foi possível identificar o processo.', true); return; }
  if (cpf.length !== 11) { toast('Digite um CPF válido (11 números).', true); return; }
  btnEnviarCpf.disabled = true; btnEnviarCpf.textContent = 'Enviando...';
  const { error } = await supabase.from('aprovacao_cpf_solicitacoes').insert({
    aprovacao_id: id, cpf: formatarCpfMascara(cpf), nome_titular: nomeInput?.value?.trim() || null,
    solicitado_por: currentUsuario?.id || null,
  });
  btnEnviarCpf.disabled = false; btnEnviarCpf.textContent = 'Enviar para consulta';
  if (error) { toast('Erro ao enviar: ' + error.message, true); return; }
  toast('CPF enviado para consulta.');
  if (cpfInput) cpfInput.value = '';
  if (nomeInput) nomeInput.value = '';
  carregarCpfSolicitacoes(id);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'ap-cpf-numero') e.target.value = formatarCpfMascara(e.target.value);
});

document.addEventListener('click', async (e) => {
  const btnMarcar = e.target.closest('[data-action="cpf-marcar-consultado"]');
  if (!btnMarcar) return;
  const resultado = prompt('Resultado da consulta (opcional — ex: "aprovado" ou "restrição no Serasa"):') || null;
  const { error } = await supabase.from('aprovacao_cpf_solicitacoes')
    .update({ status: 'consultado', resultado, consultado_em: new Date().toISOString(), consultado_por: currentUsuario?.id || null })
    .eq('id', btnMarcar.dataset.id);
  if (error) { toast('Erro ao atualizar: ' + error.message, true); return; }
  toast('Marcado como consultado.');
  const idAtual = document.getElementById('ap-id')?.value;
  if (idAtual) carregarCpfSolicitacoes(idAtual);
});

// Botão de 1 clique: usa o CPF já cadastrado do proponente (não precisa digitar).
document.addEventListener('click', async (e) => {
  const btnRapido = e.target.closest('[data-action="cpf-consultar-proponente"]');
  if (!btnRapido) return;
  btnRapido.disabled = true;
  btnRapido.textContent = 'Enviando...';
  const { error } = await supabase.from('aprovacao_cpf_solicitacoes').insert({
    aprovacao_id: btnRapido.dataset.id, cpf: btnRapido.dataset.cpf, nome_titular: btnRapido.dataset.nome,
    solicitado_por: currentUsuario?.id || null,
  });
  if (error) { toast('Erro ao enviar: ' + error.message, true); btnRapido.disabled = false; btnRapido.textContent = `📨 Consultar CPF — ${btnRapido.dataset.nome}`; return; }
  toast(`CPF de ${btnRapido.dataset.nome} enviado para consulta.`);
  btnRapido.textContent = '✅ Enviado';
  carregarCpfSolicitacoes(btnRapido.dataset.id);
});

function abrirAprovacaoLeitura(a) {
  const temProponente2 = !!a.comprador2;
  const proponentes = [
    { chave: 'proponente1', label: 'Proponente 1', nome: a.comprador?.nome, cpf: a.comprador?.cpf_cnpj },
    ...(temProponente2 ? [{ chave: 'proponente2', label: 'Proponente 2', nome: a.comprador2?.nome, cpf: a.comprador2?.cpf_cnpj }] : []),
  ];
  // Corretor pode pedir consulta de CPF no próprio lead — isso continua
  // liberado (não é upload de documento, é só um número digitado).
  const podeConsultarCpf = a.corretor_id === currentUsuario?.id;

  // Checklist só de leitura: mostra o que falta ou confirma completo, mas
  // não deixa o corretor anexar nada — quem sobe arquivo é só a Daiane.
  const exigencias = obterExigenciasDocumento(a.tipo_processo, a.tipo_renda);
  const dispensadas = new Set(a.categorias_dispensadas || []);
  let checklistHtml;
  if (exigencias === null) {
    checklistHtml = `<p class="dash-vazio">⚠️ A Daiane ainda precisa definir o tipo de renda do cliente pra saber quais documentos exigir.</p>`;
  } else if (!exigencias.arquivos.length) {
    checklistHtml = `<p class="dash-vazio">Nenhum documento obrigatório pra esse tipo de processo.</p>`;
  } else {
    const faltando = exigencias.arquivos.filter((c) => !a.categoriasPresentes?.has(c) && !dispensadas.has(c));
    checklistHtml = faltando.length
      ? `<p class="dash-vazio" style="color:#ffb648; font-weight:600;">📎 Ainda falta enviar pra Daiane: ${faltando.map((c) => APROVACAO_CATEGORIAS_ARQUIVO[c] || c).join(', ')}.</p>
         <p class="dash-linha-sub">Envie esses documentos direto pra Daiane (WhatsApp/e-mail). Assim que ela anexar tudo aqui no sistema, esse aviso fica verde.</p>`
      : `<p class="dash-vazio" style="color:#2fa86a; font-weight:700;">✅ Documentação completa.</p>`;
  }
  const textosHtml = exigencias?.textos?.length
    ? `<p class="dash-linha-sub" style="margin-top:8px;">📞 Confirme também com a Daiane: ${exigencias.textos.join(', ')} (isso não vira arquivo).</p>`
    : '';

  openModal(`
    <h2>Processo — ${APROVACAO_TIPOS[a.tipo_processo] || a.tipo_processo}</h2>
    <p><strong>Proponente 1:</strong> ${escapeHtml(a.comprador?.nome || '—')}</p>
    ${temProponente2 ? `<p><strong>Proponente 2:</strong> ${escapeHtml(a.comprador2?.nome || '—')}</p>` : ''}
    <p><strong>Status atual:</strong> ${APROVACAO_STATUS_LABEL[a.status] || a.status}</p>
    <p><strong>Última atualização:</strong> ${dateTime(a.atualizado_em)}</p>
    ${a.data_prevista_assinatura ? `<p><strong>Assinatura prevista:</strong> ${new Date(a.data_prevista_assinatura + 'T00:00:00').toLocaleDateString('pt-BR')}</p>` : ''}
    ${a.observacoes ? `<p><strong>Observações:</strong> ${escapeHtml(a.observacoes)}</p>` : ''}
    <h3 style="margin-top:16px;">Histórico de status</h3>
    <ul class="aprovacao-historico" id="aprovacaoHistorico"><li>Carregando...</li></ul>
    <h3 style="margin-top:8px;">Documentação exigida</h3>
    <input type="hidden" id="ap-id" value="${a.id}">
    ${checklistHtml}
    ${textosHtml}
    <h3 style="margin-top:20px;">Consulta de CPF</h3>
    ${podeConsultarCpf ? `
    <div id="aprovacaoCpfLista" class="contrato-arquivos-lista"><p class="dash-vazio">Carregando...</p></div>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;">
      ${proponentes.map((p) => p.cpf
        ? `<button type="button" class="btn btn-ghost btn-sm" data-action="cpf-consultar-proponente" data-cpf="${escapeHtml(p.cpf)}" data-nome="${escapeHtml(p.nome || p.label)}" data-id="${a.id}">📨 Consultar CPF — ${escapeHtml(p.nome || p.label)}</button>`
        : `<span class="dash-linha-sub" style="align-self:center;">${p.label}${p.nome ? ' (' + escapeHtml(p.nome) + ')' : ''}: CPF não cadastrado — use o campo abaixo</span>`
      ).join('')}
    </div>
    <p class="dash-linha-sub" style="margin:10px 0 4px;">Outra pessoa (cônjuge não cadastrado, etc.) — digite manualmente:</p>
    <div class="contrato-arquivos-upload">
      <input type="text" id="ap-cpf-numero" placeholder="CPF (ex: 000.000.000-00)" style="max-width:220px;">
      <input type="text" id="ap-cpf-nome" placeholder="Nome — opcional" style="max-width:220px;">
      <button type="button" class="btn btn-ghost btn-sm" id="ap-cpf-enviar">Enviar para consulta</button>
    </div>
    ` : `<p class="dash-vazio">Peça a consulta de CPF diretamente com a Daiane.</p>`}
  `, { persistente: false });
  carregarHistoricoAprovacao(a.id);
  if (podeConsultarCpf) carregarCpfSolicitacoes(a.id);
}

$('#newAprovacaoBtn')?.addEventListener('click', async () => {
  if (!podeVerAprovacoes) return;
  const dados = await aprovacaoFormDados();
  openModal(aprovacaoForm({}, dados));
  bindAprovacaoForm();
});

// ---- Novo processo pro corretor, quando o cliente JÁ está cadastrado no
// sistema (o "+ Consulta de CPF" é só pra pessoa nova, esse aqui cobre o
// caso comum: lead que já é cliente e agora precisa abrir aprovação) ----
async function abrirNovoProcessoCorretorForm() {
  const [{ data: pessoas }, { data: imoveis }, { data: instituicoes }] = await Promise.all([
    supabase.from('pessoas').select('id,nome').order('nome'),
    supabase.from('imoveis').select('id,titulo').order('titulo'),
    supabase.from('instituicoes').select('id,nome,tipo').eq('ativo', true).order('nome'),
  ]);
  const listaPessoas = pessoas || [];
  const listaImoveis = imoveis || [];
  const listaInstituicoes = instituicoes || [];

  const optPessoas = (selecionado) => listaPessoas.map((p) => `<option value="${p.id}" ${p.id === selecionado ? 'selected' : ''}>${escapeHtml(p.nome)}</option>`).join('');
  const renderOpcoesInstituicao = (tipo) => {
    const filtradas = listaInstituicoes.filter((i) => i.tipo === tipo);
    const opcoes = filtradas.map((i) => `<option value="${i.id}">${escapeHtml(i.nome)}</option>`).join('');
    const podeAdicionar = tipo === 'incorporadora';
    return `<option value="">— não definida —</option>${opcoes}${podeAdicionar ? '<option value="__nova__">+ Cadastrar nova incorporadora...</option>' : ''}`;
  };

  openModal(`
    <h2>Novo processo — meu cliente</h2>
    <p class="dash-linha-sub" style="margin-bottom:14px;">Use quando o cliente já está cadastrado no sistema e precisa abrir um processo de aprovação (financiamento, loteadora, incorporadora ou cartório).</p>
    <form id="npcForm">
      <div class="form-row full"><label>Cliente — Proponente 1 *</label>
        <select id="npc-comprador" required><option value="">Selecione...</option>${optPessoas()}</select>
      </div>
      <div class="form-row full"><label>Proponente 2 (opcional — cônjuge, coobrigado...)</label>
        <select id="npc-comprador2"><option value="">— nenhum —</option>${optPessoas()}</select>
      </div>
      <div class="form-row full"><label>Imóvel vinculado (opcional)</label>
        <select id="npc-imovel"><option value="">— nenhum —</option>${listaImoveis.map((i) => `<option value="${i.id}">${escapeHtml(i.titulo)}</option>`).join('')}</select>
      </div>
      <div class="form-row full"><label>Tipo de processo</label>
        <select id="npc-tipo">${Object.entries(APROVACAO_TIPOS).map(([k, v]) => `<option value="${k}" ${k === 'financiamento' ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="form-row full" id="npc-tipo-renda-wrap"><label>Tipo de renda do cliente</label>
        <select id="npc-tipo-renda">
          <option value="">— não definido —</option>
          <option value="clt">CLT (carteira assinada)</option>
          <option value="informal">Renda informal / autônomo</option>
          <option value="aposentado">Aposentado / pensionista</option>
        </select>
      </div>
      <div class="form-row full"><label>Instituição / Incorporadora (opcional)</label>
        <select id="npc-instituicao">${renderOpcoesInstituicao('financiamento')}</select>
      </div>
      <div class="form-row full" id="npc-nova-instituicao-wrap" hidden>
        <label>Nome da nova incorporadora</label>
        <div style="display:flex; gap:8px;">
          <input id="npc-nova-instituicao-nome" placeholder="Ex: Pride Construtora">
          <button type="button" class="btn btn-ghost btn-sm" id="npc-nova-instituicao-salvar">Cadastrar</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelNovoProcessoCorretor">Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar processo</button>
      </div>
    </form>
  `, { persistente: false });
  $('#cancelNovoProcessoCorretor').addEventListener('click', closeModal);

  $('#npc-tipo').addEventListener('change', (e) => {
    $('#npc-instituicao').innerHTML = renderOpcoesInstituicao(e.target.value);
    $('#npc-nova-instituicao-wrap').hidden = true;
    $('#npc-tipo-renda-wrap').hidden = e.target.value === 'cartorio';
  });

  $('#npc-instituicao').addEventListener('change', (e) => {
    $('#npc-nova-instituicao-wrap').hidden = e.target.value !== '__nova__';
  });

  $('#npc-nova-instituicao-salvar').addEventListener('click', async () => {
    const nomeNova = $('#npc-nova-instituicao-nome').value.trim();
    if (!nomeNova) { toast('Digite o nome da incorporadora.', true); return; }
    const btnSalvar = $('#npc-nova-instituicao-salvar');
    btnSalvar.disabled = true; btnSalvar.textContent = 'Cadastrando...';
    const { data: nova, error } = await supabase.from('instituicoes')
      .insert({ nome: nomeNova, tipo: 'incorporadora' }).select('id,nome,tipo').single();
    btnSalvar.disabled = false; btnSalvar.textContent = 'Cadastrar';
    if (error) { toast('Erro ao cadastrar incorporadora: ' + error.message, true); return; }
    listaInstituicoes.push(nova);
    $('#npc-instituicao').innerHTML = renderOpcoesInstituicao('incorporadora');
    $('#npc-instituicao').value = nova.id;
    $('#npc-nova-instituicao-wrap').hidden = true;
    toast('Incorporadora cadastrada e selecionada.');
  });

  $('#npcForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const compradorId = $('#npc-comprador').value;
    const comprador2Id = $('#npc-comprador2').value || null;
    const imovelId = $('#npc-imovel').value || null;
    const tipoProcesso = $('#npc-tipo').value;
    const instituicaoId = $('#npc-instituicao').value;
    if (!compradorId) { toast('Selecione o cliente (Proponente 1).', true); return; }
    if (instituicaoId === '__nova__') { toast('Cadastre a incorporadora nova antes de continuar (botão "Cadastrar").', true); return; }

    btn.disabled = true; btn.textContent = 'Criando...';
    const { error } = await supabase.from('aprovacoes').insert({
      tipo_processo: tipoProcesso, tipo_renda: tipoProcesso === 'cartorio' ? null : ($('#npc-tipo-renda').value || null),
      comprador_id: compradorId, comprador2_id: comprador2Id,
      imovel_id: imovelId, instituicao_id: instituicaoId || null,
      corretor_id: currentUsuario.id, status: 'documentacao_coleta', criado_por: currentUsuario.id,
    });
    if (error) { toast('Erro ao criar processo: ' + error.message, true); btn.disabled = false; btn.textContent = 'Criar processo'; return; }
    toast('Processo criado com sucesso.');
    closeModal();
    loadAprovacoes();
  });
}

document.addEventListener('click', async (e) => {
  const btnExcluirProcesso = e.target.closest('#ap-excluir-processo');
  if (!btnExcluirProcesso) return;
  if (!confirm('Excluir este processo de aprovação? Isso apaga também o histórico de status, os documentos anexados e os pedidos de consulta de CPF ligados a ele. Essa ação não pode ser desfeita.')) return;
  btnExcluirProcesso.disabled = true;
  const { error } = await supabase.from('aprovacoes').delete().eq('id', btnExcluirProcesso.dataset.id);
  if (error) { toast('Erro ao excluir: ' + error.message, true); btnExcluirProcesso.disabled = false; return; }
  toast('Processo excluído.');
  closeModal();
  loadAprovacoes();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#newProcessoCorretorBtn')) abrirNovoProcessoCorretorForm();
});


// Cria pessoa + lead (status "em atendimento", corretor = quem está logado)
// + processo de aprovação (financiamento, status "verificação de CPF") +
// o pedido de consulta, tudo numa tacada só, direto da aba Aprovações.
async function abrirConsultaRapidaForm() {
  const { data: instituicoes } = await supabase.from('instituicoes').select('id,nome,tipo').eq('ativo', true).order('nome');
  const lista = instituicoes || [];

  const renderOpcoesInstituicao = (tipo) => {
    const filtradas = lista.filter((i) => i.tipo === tipo);
    const opcoes = filtradas.map((i) => `<option value="${i.id}">${escapeHtml(i.nome)}</option>`).join('');
    const podeAdicionar = tipo === 'incorporadora';
    return `<option value="">— não definida —</option>${opcoes}${podeAdicionar ? '<option value="__nova__">+ Cadastrar nova incorporadora...</option>' : ''}`;
  };

  openModal(`
    <h2>Consulta de CPF — pessoa nova</h2>
    <p class="dash-linha-sub" style="margin-bottom:14px;">Isso cadastra a pessoa, cria um lead pra você no funil de vendas (status "em atendimento") e já manda o CPF pra Daiane consultar.</p>
    <form id="consultaRapidaForm">
      <div class="form-row full"><label>Nome completo *</label><input id="cr-nome" required></div>
      <div class="form-row full"><label>Telefone *</label><input id="cr-telefone" required placeholder="(41) 99999-9999"></div>
      <div class="form-row full"><label>CPF a ser consultado *</label><input id="cr-cpf" required placeholder="000.000.000-00"></div>
      <div class="form-row full"><label>Tipo de processo</label>
        <select id="cr-tipo">${Object.entries(APROVACAO_TIPOS).map(([k, v]) => `<option value="${k}" ${k === 'financiamento' ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="form-row full" id="cr-tipo-renda-wrap"><label>Tipo de renda do cliente</label>
        <select id="cr-tipo-renda">
          <option value="">— não definido —</option>
          <option value="clt">CLT (carteira assinada)</option>
          <option value="informal">Renda informal / autônomo</option>
          <option value="aposentado">Aposentado / pensionista</option>
        </select>
      </div>
      <div class="form-row full"><label>Instituição / Incorporadora (opcional)</label>
        <select id="cr-instituicao">${renderOpcoesInstituicao('financiamento')}</select>
      </div>
      <div class="form-row full" id="cr-nova-instituicao-wrap" hidden>
        <label>Nome da nova incorporadora</label>
        <div style="display:flex; gap:8px;">
          <input id="cr-nova-instituicao-nome" placeholder="Ex: Pride Construtora">
          <button type="button" class="btn btn-ghost btn-sm" id="cr-nova-instituicao-salvar">Cadastrar</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelConsultaRapida">Cancelar</button>
        <button type="submit" class="btn btn-primary">Cadastrar e enviar</button>
      </div>
    </form>
  `, { persistente: false });
  $('#cancelConsultaRapida').addEventListener('click', closeModal);
  $('#cr-cpf').addEventListener('input', (e) => { e.target.value = formatarCpfMascara(e.target.value); });

  $('#cr-tipo').addEventListener('change', (e) => {
    $('#cr-instituicao').innerHTML = renderOpcoesInstituicao(e.target.value);
    $('#cr-nova-instituicao-wrap').hidden = true;
    $('#cr-tipo-renda-wrap').hidden = e.target.value === 'cartorio';
  });

  $('#cr-instituicao').addEventListener('change', (e) => {
    $('#cr-nova-instituicao-wrap').hidden = e.target.value !== '__nova__';
  });

  $('#cr-nova-instituicao-salvar').addEventListener('click', async () => {
    const nomeNova = $('#cr-nova-instituicao-nome').value.trim();
    if (!nomeNova) { toast('Digite o nome da incorporadora.', true); return; }
    const btnSalvar = $('#cr-nova-instituicao-salvar');
    btnSalvar.disabled = true; btnSalvar.textContent = 'Cadastrando...';
    const { data: nova, error } = await supabase.from('instituicoes')
      .insert({ nome: nomeNova, tipo: 'incorporadora' }).select('id,nome,tipo').single();
    btnSalvar.disabled = false; btnSalvar.textContent = 'Cadastrar';
    if (error) { toast('Erro ao cadastrar incorporadora: ' + error.message, true); return; }
    lista.push(nova);
    $('#cr-instituicao').innerHTML = renderOpcoesInstituicao('incorporadora');
    $('#cr-instituicao').value = nova.id;
    $('#cr-nova-instituicao-wrap').hidden = true;
    toast('Incorporadora cadastrada e selecionada.');
  });

  $('#consultaRapidaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const nome = $('#cr-nome').value.trim();
    const telefone = $('#cr-telefone').value.trim();
    const cpf = $('#cr-cpf').value.replace(/\D/g, '');
    const tipoProcesso = $('#cr-tipo').value;
    const instituicaoId = $('#cr-instituicao').value;
    if (!nome || !telefone) { toast('Preencha nome e telefone.', true); return; }
    if (cpf.length !== 11) { toast('Digite um CPF válido (11 números).', true); return; }
    if (instituicaoId === '__nova__') { toast('Cadastre a incorporadora nova antes de continuar (botão "Cadastrar").', true); return; }

    btn.disabled = true; btn.textContent = 'Cadastrando...';
    try {
      // 1) Pessoa
      const { data: pessoa, error: erroPessoa } = await supabase.from('pessoas')
        .insert({ nome, telefone, cpf_cnpj: cpf, tipo_pessoa: 'fisica', papeis: ['lead', 'comprador'] })
        .select('id').single();
      if (erroPessoa) throw new Error('Erro ao cadastrar pessoa: ' + erroPessoa.message);

      // 2) Lead, já em atendimento com o corretor logado
      const { error: erroLead } = await supabase.from('leads').insert({
        nome, telefone, pessoa_id: pessoa.id, corretor_id: currentUsuario.id,
        status: 'tentativa_1', origem: 'outro', interesse: 'compra',
        observacoes: 'Lead criado a partir de consulta de CPF na aba Aprovações.',
        atribuido_em: new Date().toISOString(),
      });
      if (erroLead) throw new Error('Pessoa cadastrada, mas houve erro ao criar o lead: ' + erroLead.message);

      // 3) Processo de aprovação, no tipo escolhido pelo corretor
      const { data: aprov, error: erroAprov } = await supabase.from('aprovacoes').insert({
        tipo_processo: tipoProcesso, tipo_renda: tipoProcesso === 'cartorio' ? null : ($('#cr-tipo-renda').value || null),
        comprador_id: pessoa.id, corretor_id: currentUsuario.id,
        instituicao_id: instituicaoId || null, status: 'verificacao_cpf', criado_por: currentUsuario.id,
      }).select('id').single();
      if (erroAprov) throw new Error('Lead criado, mas houve erro ao abrir o processo: ' + erroAprov.message);

      // 4) Pedido de consulta de CPF
      const { error: erroCpf } = await supabase.from('aprovacao_cpf_solicitacoes').insert({
        aprovacao_id: aprov.id, cpf: formatarCpfMascara(cpf), nome_titular: nome, solicitado_por: currentUsuario.id,
      });
      if (erroCpf) throw new Error('Processo criado, mas houve erro ao enviar o CPF: ' + erroCpf.message);

      toast('Pessoa cadastrada, lead criado e CPF enviado para consulta.');
      closeModal();
      loadAprovacoes();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false; btn.textContent = 'Cadastrar e enviar';
    }
  });
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#newConsultaRapidaBtn')) abrirConsultaRapidaForm();
});

document.addEventListener('click', async (e) => {
  const abrir = e.target.closest('[data-action="aprovacao-abrir"]');
  if (abrir) {
    const { data: a, error } = await supabase.from('aprovacoes')
      .select('*, comprador:pessoas!aprovacoes_comprador_id_fkey(nome, cpf_cnpj), comprador2:pessoas!aprovacoes_comprador2_id_fkey(nome, cpf_cnpj)')
      .eq('id', abrir.dataset.id).single();
    if (error || !a) { toast('Não foi possível abrir o processo.', true); return; }
    if (podeVerAprovacoes) {
      const dados = await aprovacaoFormDados();
      openModal(aprovacaoForm(a, dados));
      bindAprovacaoForm();
    } else {
      const { data: arquivosDoProcesso } = await supabase.from('aprovacao_arquivos').select('categoria').eq('aprovacao_id', a.id);
      a.categoriasPresentes = new Set((arquivosDoProcesso || []).map((x) => x.categoria));
      abrirAprovacaoLeitura(a);
    }
    return;
  }

  if (e.target.closest('#ap-arq-upload')) {
    const btn = e.target.closest('#ap-arq-upload');
    const id = $('#ap-id').value;
    const file = $('#ap-arq-file').files[0];
    const categoria = $('#ap-arq-categoria').value;
    const descricao = $('#ap-arq-descricao')?.value?.trim() || null;
    const titular = $('#ap-arq-titular')?.value || 'proponente1';
    if (!id) { toast('Salve o processo antes de anexar documentos.', true); return; }
    if (!file) { toast('Selecione um arquivo primeiro.', true); return; }
    btn.disabled = true; btn.textContent = 'Enviando...';
    const caminho = `${id}/${categoria}/${Date.now()}-${file.name}`;
    const { error: erroUp } = await supabase.storage.from(APROVACAO_ARQUIVOS_BUCKET)
      .upload(caminho, file, { contentType: file.type || 'application/octet-stream' });
    if (erroUp) { toast('Erro ao enviar arquivo: ' + erroUp.message, true); btn.disabled = false; btn.textContent = 'Enviar arquivo'; return; }
    const { error: erroIns } = await supabase.from('aprovacao_arquivos').insert({
      aprovacao_id: id, categoria, nome_arquivo: file.name, storage_path: caminho, descricao, titular,
      tamanho_bytes: file.size, tipo_mime: file.type || null, enviado_por: currentUsuario?.id || null,
    });
    if (erroIns) { toast('Erro ao registrar arquivo: ' + erroIns.message, true); btn.disabled = false; btn.textContent = 'Enviar arquivo'; return; }
    toast('Arquivo enviado.');
    $('#ap-arq-file').value = '';
    if ($('#ap-arq-descricao')) $('#ap-arq-descricao').value = '';
    btn.disabled = false; btn.textContent = 'Enviar arquivo';
    carregarArquivosAprovacao(id);
  }

  const baixar = e.target.closest('[data-action="aprovacao-arquivo-baixar"]');
  if (baixar) {
    const { data, error } = await supabase.storage.from(APROVACAO_ARQUIVOS_BUCKET).createSignedUrl(baixar.dataset.path, 60);
    if (error || !data?.signedUrl) { toast('Não foi possível baixar: ' + (error?.message || 'indisponível'), true); return; }
    const link = document.createElement('a');
    link.href = data.signedUrl;
    link.download = baixar.dataset.nome;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  const excluirArq = e.target.closest('[data-action="aprovacao-arquivo-excluir"]');
  if (excluirArq) {
    if (!confirm('Excluir este documento? Essa ação não pode ser desfeita.')) return;
    await supabase.storage.from(APROVACAO_ARQUIVOS_BUCKET).remove([excluirArq.dataset.path]);
    const { error } = await supabase.from('aprovacao_arquivos').delete().eq('id', excluirArq.dataset.id);
    if (error) { toast('Erro ao excluir: ' + error.message, true); return; }
    toast('Documento excluído.');
    carregarArquivosAprovacao($('#ap-id').value);
  }

  const excluirInst = e.target.closest('[data-action="instituicao-excluir"]');
  if (excluirInst) {
    if (!souGerente) { toast('Somente o gerente pode excluir instituições.', true); return; }
    if (!confirm('Excluir esta instituição? Processos que já a usam ficam sem instituição definida.')) return;
    const { error } = await supabase.from('instituicoes').delete().eq('id', excluirInst.dataset.id);
    if (error) { toast('Erro ao excluir: ' + error.message, true); return; }
    toast('Instituição excluída.');
    carregarInstituicoes();
  }
});

$('#btnInstituicoes')?.addEventListener('click', async () => {
  if (!podeVerAprovacoes) return;
  openModal(`
    <h2>Instituições</h2>
    <p class="dash-vazio">Correspondentes bancárias, loteadoras e cartórios usados nos processos de aprovação.</p>
    <div id="instituicoesLista"><p class="dash-vazio">Carregando...</p></div>
    <form class="modal-form" id="instituicaoForm" style="margin-top:12px;">
      <div class="form-row"><label>Nome</label><input id="inst-nome" required></div>
      <div class="form-row"><label>Tipo</label>
        <select id="inst-tipo">
          ${Object.entries(APROVACAO_TIPOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </div>
      <div class="form-row full"><label>Contato (opcional)</label><input id="inst-contato" placeholder="telefone, e-mail ou pessoa de contato"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelInstituicao">Fechar</button>
        <button type="submit" class="btn btn-primary">Adicionar</button>
      </div>
    </form>
  `, { persistente: false });
  $('#cancelInstituicao').addEventListener('click', closeModal);
  carregarInstituicoes();
  $('#instituicaoForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nome = $('#inst-nome').value.trim();
    if (!nome) { toast('Informe o nome da instituição.', true); return; }
    const { error } = await supabase.from('instituicoes').insert({
      nome, tipo: $('#inst-tipo').value, contato: $('#inst-contato').value.trim() || null,
    });
    if (error) { toast('Erro ao adicionar: ' + error.message, true); return; }
    toast('Instituição adicionada.');
    $('#inst-nome').value = ''; $('#inst-contato').value = '';
    carregarInstituicoes();
  });
});

async function carregarInstituicoes() {
  const wrap = $('#instituicoesLista');
  if (!wrap) return;
  const { data, error } = await supabase.from('instituicoes').select('*').order('tipo').order('nome');
  if (error) { wrap.innerHTML = '<p class="dash-vazio">Erro ao carregar.</p>'; console.error(error); return; }
  if (!data.length) { wrap.innerHTML = '<p class="dash-vazio">Nenhuma instituição cadastrada ainda.</p>'; return; }
  const porTipo = {};
  data.forEach((i) => { (porTipo[i.tipo] = porTipo[i.tipo] || []).push(i); });
  wrap.innerHTML = Object.entries(porTipo).map(([tipo, itens]) => `
    <div class="dash-bucket-titulo">${APROVACAO_TIPOS[tipo] || tipo}</div>
    ${itens.map((i) => `
      <div class="contrato-arquivo-item">
        <div class="contrato-arquivo-info">
          <span class="contrato-arquivo-nome">${escapeHtml(i.nome)}${i.ativo ? '' : ' (inativa)'}</span>
          ${i.contato ? `<span class="dash-linha-sub">${escapeHtml(i.contato)}</span>` : ''}
        </div>
        ${souGerente ? `<button type="button" class="tarefa-excluir" data-action="instituicao-excluir" data-id="${i.id}" title="Excluir">✕</button>` : ''}
      </div>
    `).join('')}
  `).join('');
}

// =====================================================================
// INIT
// =====================================================================
checkSession();
