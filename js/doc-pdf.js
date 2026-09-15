// =====================================================================
// GERADOR DE DOCUMENTOS EM PDF (motor interno — não depende de arquivo .docx)
// Script clássico (não-módulo), carregado antes de js/app.js, expõe
// window.gerarPdfDocumento(modelo, dados).
// =====================================================================
(function () {
  'use strict';

  // A partir da reescrita 0.3.x do pdfmake, o vfs_fonts.js só carrega os
  // arquivos de fonte na "virtual file system" — ele NÃO configura mais
  // sozinho o mapeamento pdfMake.fonts (nome da fonte -> arquivo .ttf) como
  // as versões antigas faziam. Sem isso, referenciar font:'Roboto' trava a
  // geração do PDF silenciosamente (nunca chama o callback).
  //
  // NÃO apontamos para os nomes de arquivo dentro do vfs (ex: 'Roboto-Medium.ttf')
  // porque o registro da vfs via addVirtualFileSystem(), feito pelo próprio
  // vfs_fonts.js ao carregar, se mostrou instável em produção — em alguns
  // carregamentos o arquivo em negrito ('Roboto-Medium.ttf') não fica
  // disponível a tempo, e a geração falha com "File 'Roboto-Medium.ttf' not
  // found in virtual file system". Para eliminar essa instabilidade,
  // apontamos direto para as URLs dos .ttf no CDN — o pdfmake baixa cada
  // arquivo sob demanda (com cache do navegador) em vez de depender da vfs.
  if (typeof pdfMake !== 'undefined') {
    const BASE_FONTE = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.3.3/fonts/Roboto/';
    pdfMake.fonts = {
      Roboto: {
        normal: BASE_FONTE + 'Roboto-Regular.ttf',
        bold: BASE_FONTE + 'Roboto-Medium.ttf',
        italics: BASE_FONTE + 'Roboto-Italic.ttf',
        bolditalics: BASE_FONTE + 'Roboto-MediumItalic.ttf',
      },
    };
  }

  // ---------- helpers de template de texto ----------
  function resolverTexto(str, dados) {
    if (!str) return '';
    str = str.replace(/\{#(\w+)\}([\s\S]*?)\{\/\1\}/g, (_, k, inner) => (dados[k] ? inner : ''));
    str = str.replace(/\{\^(\w+)\}([\s\S]*?)\{\/\1\}/g, (_, k, inner) => (!dados[k] ? inner : ''));
    str = str.replace(/\{(\w+)\}/g, (_, k) => (dados[k] !== undefined && dados[k] !== null ? String(dados[k]) : ''));
    return str;
  }

  function slugArquivo(nome) {
    return (nome || 'documento')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'documento';
  }

  function dataHojeArquivo() {
    return new Date().toISOString().slice(0, 10);
  }

  // ---------- construtores de bloco (mesma estrutura dos modelos .docx originais) ----------
  const titulo = (texto) => ({ tipo: 'titulo', texto });
  const identificacao = () => ({ tipo: 'identificacao' });
  const labelPar = (label, resto) => ({ tipo: 'label', label, resto });
  const par = (texto, opts) => ({ tipo: 'par', texto, opts: opts || {} });
  const clausula = (numero, tit, corpo) => ({ tipo: 'clausula', numero, titulo: tit, corpo });
  const subitem = (texto) => ({ tipo: 'subitem', texto });
  const runsPar = (parts, opts) => ({ tipo: 'runs', parts, opts: opts || {} });
  const assinaturas = (labels) => ({ tipo: 'assinaturas', labels });
  const testemunhas = () => ({ tipo: 'testemunhas' });
  const disclaimer = () => ({ tipo: 'disclaimer' });
  // Tabela de lançamentos dinâmica: fieldTag aponta para um campo de dados
  // (textarea) cujas linhas são "coluna1|coluna2|coluna3"; renderizada em
  // pdfMake como tabela de verdade. Não faz parte do texto editável (ver
  // TIPOS_CORPO_EDITAVEL) — os valores mudam a cada geração, não fazem
  // sentido como texto de cláusula fixo.
  const tabela = (rotulo, fieldTag, colunas, textoVazio) => ({ tipo: 'tabela', rotulo, fieldTag, colunas, textoVazio: textoVazio || 'Nenhum lançamento neste período.' });
  // Tabela de imóveis comparados, com a coluna de link clicável (abre o
  // anúncio original no navegador ao clicar, dentro do PDF). fieldTag aponta
  // pra um textarea com 1 linha por imóvel: "Descrição | Valor | Área | Link".
  const tabelaComparados = (fieldTag) => ({ tipo: 'tabela_comparados', fieldTag });
  // Galeria de fotos do imóvel avaliado. fieldTag aponta pra um array de
  // data-URIs base64 (lido do input de arquivo no formulário).
  const fotos = (fieldTag, rotulo) => ({ tipo: 'fotos', fieldTag, rotulo });

  // Estes 5 tipos são estruturais/fixos: sempre gerados pelo sistema, nunca
  // fazem parte do texto editável (cabeçalho do título, identificação legal
  // da imobiliária, bloco de assinaturas, testemunhas e aviso legal).
  function blocoParaPdf(bloco, dados, imagens) {
    imagens = imagens || {};
    switch (bloco.tipo) {
      case 'titulo':
        return { text: resolverTexto(bloco.texto, dados), style: 'titulo' };
      case 'identificacao':
        return {
          stack: [
            { text: resolverTexto('{imobiliaria_nome} — {imobiliaria_razao_social}, CNPJ nº {imobiliaria_cnpj}, CRECI {imobiliaria_creci}, com sede em {imobiliaria_endereco_completo}.', dados), style: 'identificacao' },
            { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 495, y2: 0, lineWidth: 0.75, lineColor: '#dddddd' }], margin: [0, 0, 0, 14] },
          ],
        };
      case 'assinaturas': {
        const stack = [{ text: resolverTexto('{cidade_contrato}, {data_extenso}.', dados), style: 'assinData' }];
        bloco.labels.forEach((labelRaw) => {
          const label = resolverTexto(labelRaw, dados);
          if (!label) return;
          // Linha da IMOBILIÁRIA/ADMINISTRADORA (identificada pela presença do
          // tag {imobiliaria_nome} no label, convenção usada em todos os
          // modelos): recebe a assinatura fixa da empresa automaticamente,
          // se o arquivo assets/assinatura-gregorio.png estiver disponível.
          // Linhas de outras partes (locador, locatário, comprador etc.)
          // nunca recebem assinatura fixa — continuam em branco para
          // assinatura manual.
          const ehLinhaImobiliaria = /\{imobiliaria_nome\}/.test(labelRaw);
          if (ehLinhaImobiliaria && imagens.assinatura) {
            stack.push({ image: imagens.assinatura, width: 130, alignment: 'center', margin: [0, 22, 0, 2] });
            stack.push({ text: '_______________________________________________', alignment: 'center', margin: [0, 0, 0, 2] });
          } else {
            stack.push({ text: '_______________________________________________', alignment: 'center', margin: [0, 26, 0, 2] });
          }
          stack.push({ text: label, bold: true, alignment: 'center', margin: [0, 0, 0, ehLinhaImobiliaria && imagens.assinatura ? 1 : 4] });
          // Linha de apoio com o nome de quem assina fisicamente pela
          // ADMINISTRADORA e seu CPF, só na linha da imobiliária e só quando
          // a assinatura fixa está presente (senão não há o que identificar).
          if (ehLinhaImobiliaria && imagens.assinatura) {
            const identificacaoAssinante = resolverTexto('{assinante_nome} — CPF {assinante_cpf}', dados);
            if (identificacaoAssinante.trim()) {
              stack.push({ text: identificacaoAssinante, fontSize: 8.5, color: '#555555', alignment: 'center', margin: [0, 0, 0, 4] });
            }
          }
        });
        return { stack };
      }
      case 'testemunhas':
        return {
          stack: [
            { text: 'TESTEMUNHAS:', bold: true, margin: [0, 20, 0, 8] },
            { text: `1) Nome: ${resolverTexto('{testemunha1_nome}', dados)}   CPF: ${resolverTexto('{testemunha1_cpf}', dados)}`, style: 'corpo' },
            { text: `2) Nome: ${resolverTexto('{testemunha2_nome}', dados)}   CPF: ${resolverTexto('{testemunha2_cpf}', dados)}`, style: 'corpo' },
          ],
        };
      case 'disclaimer':
        return { text: 'Este modelo é fornecido para uso interno da imobiliária e deve ser revisado por profissional jurídico antes da assinatura, considerando as particularidades de cada negócio.', style: 'disclaimer' };
      case 'tabela': {
        const linhasBrutas = (dados[bloco.fieldTag] || '').split('\n').map((l) => l.trim()).filter(Boolean);
        const linhas = linhasBrutas.map((l) => l.split('|').map((c) => c.trim()));
        const nCols = bloco.colunas.length;
        const ehColunaValor = (c) => /valor/i.test(c);
        const headerRow = bloco.colunas.map((c) => ({ text: c, bold: true, fontSize: 9, color: '#333333', fillColor: '#eef0f5', alignment: ehColunaValor(c) ? 'right' : 'left' }));
        const body = [headerRow];
        if (linhas.length === 0) {
          const vazio = { text: bloco.textoVazio || 'Nenhum lançamento neste período.', italics: true, color: '#888888', fontSize: 9.5, colSpan: nCols };
          const resto = Array.from({ length: nCols - 1 }, () => ({}));
          body.push([vazio, ...resto]);
        } else {
          linhas.forEach((cols) => {
            body.push(bloco.colunas.map((c, i) => ({ text: cols[i] || '—', fontSize: 9.5, alignment: ehColunaValor(c) ? 'right' : 'left' })));
          });
        }
        const widths = bloco.colunas.map((_, i) => (i === 0 ? '*' : 'auto'));
        return {
          stack: [
            bloco.rotulo ? { text: bloco.rotulo, bold: true, fontSize: 10.5, margin: [0, 6, 0, 4] } : null,
            {
              table: { headerRows: 1, widths, body },
              layout: { hLineColor: () => '#dddddd', vLineColor: () => '#dddddd', hLineWidth: () => 0.5, vLineWidth: () => 0.5, paddingTop: () => 4, paddingBottom: () => 4 },
              margin: [0, 0, 0, 10],
            },
          ].filter(Boolean),
        };
      }
      case 'tabela_comparados': {
        const linhasBrutas = (dados[bloco.fieldTag] || '').split('\n').map((l) => l.trim()).filter(Boolean);
        const linhas = linhasBrutas.map((l) => l.split('|').map((c) => c.trim()));
        const headerRow = ['Imóvel comparado', 'Valor (R$)', 'Área', 'Anúncio'].map((c, i) => ({
          text: c, bold: true, fontSize: 9, color: '#333333', fillColor: '#eef0f5', alignment: i === 1 ? 'right' : 'left',
        }));
        const body = [headerRow];
        if (!linhas.length) {
          body.push([{ text: 'Nenhum imóvel comparado informado.', italics: true, color: '#888888', fontSize: 9.5, colSpan: 4 }, {}, {}, {}]);
        } else {
          linhas.forEach((cols) => {
            const [descricao, valor, area, link] = cols;
            body.push([
              { text: descricao || '—', fontSize: 9.5 },
              { text: valor || '—', fontSize: 9.5, alignment: 'right' },
              { text: area || '—', fontSize: 9.5 },
              link
                ? { text: 'Ver anúncio ↗', link, color: '#1a56db', decoration: 'underline', fontSize: 9.5 }
                : { text: '—', fontSize: 9.5 },
            ]);
          });
        }
        return {
          stack: [
            { text: 'IMÓVEIS COMPARADOS (PESQUISA DE MERCADO)', bold: true, fontSize: 10.5, margin: [0, 6, 0, 4] },
            {
              table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto'], body },
              layout: { hLineColor: () => '#dddddd', vLineColor: () => '#dddddd', hLineWidth: () => 0.5, vLineWidth: () => 0.5, paddingTop: () => 4, paddingBottom: () => 4 },
              margin: [0, 0, 0, 10],
            },
          ],
        };
      }
      case 'fotos': {
        const lista = Array.isArray(dados[bloco.fieldTag]) ? dados[bloco.fieldTag] : [];
        if (!lista.length) return null;
        const linhas = [];
        for (let i = 0; i < lista.length; i += 2) {
          const par = lista.slice(i, i + 2).map((src) => ({ image: src, width: 235, margin: [0, 0, 0, 8] }));
          linhas.push({ columns: par, columnGap: 12 });
        }
        return {
          stack: [
            { text: bloco.rotulo || 'FOTOS DO IMÓVEL', bold: true, fontSize: 10.5, margin: [0, 6, 0, 6] },
            ...linhas,
          ],
        };
      }
      default:
        return null;
    }
  }

  // ---------- texto "do corpo" (editável por gerente/admin) ----------
  // Converte os blocos de cláusula/parágrafo/rótulo em texto puro (com as
  // mesmas tags {tag} e condicionais {#tag}...{/tag}), um por parágrafo,
  // exatamente como aparece na caixa de edição do CRM.
  function blocoCorpoParaTexto(bloco) {
    switch (bloco.tipo) {
      case 'label': return `${bloco.label} ${bloco.resto}`;
      case 'par': return bloco.texto;
      case 'clausula': return `CLÁUSULA ${bloco.numero}ª — ${bloco.titulo.toUpperCase()}. ${bloco.corpo}`;
      case 'subitem': return bloco.texto;
      case 'runs': return bloco.parts.map((p) => p.text).join('');
      default: return '';
    }
  }

  const TIPOS_CORPO_EDITAVEL = ['label', 'par', 'clausula', 'subitem', 'runs'];

  function extrairEstrutura(blocos) {
    return {
      titulo: blocos.find((b) => b.tipo === 'titulo'),
      identificacao: blocos.find((b) => b.tipo === 'identificacao'),
      assinaturas: blocos.find((b) => b.tipo === 'assinaturas'),
      testemunhas: blocos.find((b) => b.tipo === 'testemunhas'),
      disclaimer: blocos.find((b) => b.tipo === 'disclaimer'),
      corpo: blocos.filter((b) => TIPOS_CORPO_EDITAVEL.includes(b.tipo)),
    };
  }

  // Renderiza um parágrafo de texto livre (padrão OU editado por gerente/admin),
  // aplicando negrito automático no prefixo antes de um travessão
  // ("CLÁUSULA 1ª — DO OBJETO. texto...") ou antes de dois-pontos em maiúsculas
  // ("LOCADOR(A): texto..."), para manter a mesma aparência sem exigir marcação.
  function paragrafoEditavelParaPdf(textoResolvido) {
    if (!textoResolvido) return null;
    const mEmDash = textoResolvido.match(/^([^\n]{1,90}?—\s*)/);
    const mLabel = !mEmDash && textoResolvido.match(/^([A-ZÀ-Ü][A-ZÀ-Ü()/ ]{1,42}:\s*)/);
    const prefixo = (mEmDash && mEmDash[1]) || (mLabel && mLabel[1]) || null;
    if (prefixo) {
      return { text: [{ text: prefixo, bold: true }, { text: textoResolvido.slice(prefixo.length) }], style: 'corpo' };
    }
    return { text: textoResolvido, style: 'corpo' };
  }

  // ---------- conteúdo de cada um dos 10 modelos ----------
  const MODELOS_DOC_BLOCOS = {

    // 1. CONTRATO DE LOCAÇÃO RESIDENCIAL (modelo próprio Gregório | Meu Lar — 28 cláusulas)
    locacao: [
      titulo('CONTRATO DE LOCAÇÃO RESIDENCIAL'),
      identificacao(),
      labelPar('LOCADOR(A):', '{locador_nome}, {locador_nacionalidade}, {locador_estado_civil}, {locador_profissao}, portador(a) do CPF/CNPJ nº {locador_cpf}, residente e domiciliado(a) em {locador_endereco}, neste ato representado(a) pela ADMINISTRADORA {imobiliaria_nome}, CRECI {imobiliaria_creci}, por meio do(a) corretor(a) {corretor_nome} (CRECI {corretor_creci}), doravante denominada simplesmente ADMINISTRADORA.'),
      labelPar('LOCATÁRIO(A) 1:', '{locatario_nome}, {locatario_nacionalidade}, {locatario_estado_civil}, {locatario_profissao}, portador(a) do RG nº {locatario_rg} e CPF nº {locatario_cpf}, residente e domiciliado(a) em {locatario_endereco}, telefone {locatario_telefone}, e-mail {locatario_email}.'),
      par('{#tem_locatario2}LOCATÁRIO(A) 2: {locatario2_nome}, {locatario2_nacionalidade}, {locatario2_estado_civil}, {locatario2_profissao}, portador(a) do RG nº {locatario2_rg} e CPF nº {locatario2_cpf}, residente e domiciliado(a) em {locatario2_endereco}, telefone {locatario2_telefone}, e-mail {locatario2_email}.{/tem_locatario2}'),
      par('{#tem_locatario3}LOCATÁRIO(A) 3: {locatario3_nome}, {locatario3_nacionalidade}, {locatario3_estado_civil}, {locatario3_profissao}, portador(a) do RG nº {locatario3_rg} e CPF nº {locatario3_cpf}, residente e domiciliado(a) em {locatario3_endereco}, telefone {locatario3_telefone}, e-mail {locatario3_email}.{/tem_locatario3}'),
      labelPar('IMÓVEL LOCADO:', 'imóvel do tipo {imovel_tipo}, com {imovel_area_construida} m² de área privativa, {imovel_comodos_descricao}, localizado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}. {imovel_matriculas_concessionarias}'),
      par('PREÂMBULO. Por este instrumento particular, as partes acima qualificadas ajustam o presente CONTRATO DE LOCAÇÃO DE IMÓVEL PARA FINS RESIDENCIAIS, na forma da Lei nº 8.245/91, mediante as cláusulas e condições a seguir, que voluntariamente aceitam e outorgam.', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do objeto', 'O imóvel acima descrito é entregue em perfeito estado de conservação, tal como recebido, conforme Laudo de Vistoria de Entrada, que passa a integrar este contrato para todos os fins.'),
      clausula(2, 'do prazo', 'A presente locação terá início em {data_inicio} e término em {data_termino}, pelo prazo de {prazo_meses} meses. Após o {mes_resilicao_sem_multa}º mês, o LOCATÁRIO poderá rescindir o contrato sem multa, desde que comunique a intenção com antecedência mínima de {prazo_aviso_rescisao_dias} dias. O LOCADOR permanece vinculado ao prazo contratual, observadas as hipóteses previstas na Lei nº 8.245/91.'),
      subitem('Parágrafo único: este contrato poderá ser rescindido sem multa para ambas as partes após o {mes_resilicao_sem_multa}º mês, desde que a parte interessada avise a outra com {prazo_aviso_rescisao_dias} dias de antecedência do vencimento do próximo aluguel.'),
      clausula(3, 'do valor', 'O valor do aluguel, livremente convencionado, é de R$ {valor_aluguel} ({valor_aluguel_extenso}), com pagamento devido todo dia {dia_vencimento} de cada mês, através de boleto bancário ou depósito/transferência em conta indicada pela ADMINISTRADORA.'),
      subitem('Parágrafo primeiro: após o décimo segundo mês, o valor do aluguel sofrerá reajuste conforme descrito no parágrafo quarto desta cláusula.'),
      subitem('Parágrafo segundo: o boleto será enviado ao LOCATÁRIO por correio, e-mail, WhatsApp ou outro meio; na ausência de recebimento, o LOCATÁRIO deverá solicitá-lo junto à ADMINISTRADORA, no endereço constante no rodapé deste instrumento.'),
      subitem('Parágrafo terceiro: em caso de extravio do boleto, será cobrado, junto ao boleto de aluguel, o valor de {taxa_segunda_via_boleto} referente à emissão de segunda via.'),
      subitem('Parágrafo quarto: o aluguel será reajustado anualmente pelo {indice_reajuste}.'),
      subitem('Parágrafo quinto: o cálculo do mês de locação será baseado na data de vencimento do aluguel, podendo o primeiro aluguel ser proporcionalmente menor ou maior, a depender da data de início da locação.'),
      clausula(4, 'do atraso no pagamento de aluguel', 'Os aluguéis pagos fora do prazo estipulado na cláusula anterior serão acrescidos de multa de {multa_atraso_percentual}% (por cento), juros moratórios de {juros_mora_percentual}% (por cento) ao mês e correção monetária pro rata tempore, calculados sobre o valor devido.'),
      subitem('Parágrafo primeiro: decorridos {prazo_cobranca_honorarios_dias} dias corridos após o vencimento, além dos acréscimos acima, o LOCATÁRIO pagará honorários advocatícios de cobrança extrajudicial de {honorarios_extrajudicial_percentual}% e, em caso de cobrança judicial, honorários de {honorarios_judiciais_percentual}%, além das custas processuais da ação.'),
      subitem('Parágrafo segundo: o inadimplemento dos aluguéis e/ou encargos faculta à ADMINISTRADORA, após notificação prévia de 5 (cinco) dias, incluir os dados do LOCATÁRIO nos serviços de proteção ao crédito, cabendo a este o pagamento de todas as despesas de reabilitação decorrentes, que ocorrerá somente após a quitação integral dos débitos.'),
      subitem('Parágrafo terceiro: o LOCATÁRIO tem ciência de que os direitos creditórios decorrentes deste contrato poderão ser cedidos a empresas de cobrança, ficando o cessionário autorizado a praticar os atos necessários à cobrança, negativação ou protesto para preservação dos direitos cedidos.'),
      clausula(5, 'das condições e vistoria do imóvel', 'O imóvel apresenta eventuais pequenas avarias que não impedem seu uso, gozo e habitabilidade, sendo entregue nas condições descritas no Laudo de Vistoria de Entrada, facultado ao LOCATÁRIO acompanhar a vistoria técnica; em caso de ausência, presume-se concordância tácita com os termos ali descritos.'),
      subitem('Parágrafo primeiro: fica estipulado o prazo de {prazo_contestacao_vistoria_dias} dias corridos, contados da assinatura deste instrumento, para contestação do Laudo de Vistoria de Entrada, por e-mail ou outro meio indicado pela ADMINISTRADORA.'),
      subitem('Parágrafo segundo: na Vistoria de Saída também é facultado o comparecimento do LOCATÁRIO; caso as chaves sejam restituídas por pessoa diversa, esta fica autorizada a assinar o Laudo de Vistoria de Saída em nome daquele.'),
      subitem('Parágrafo terceiro: a ausência de assinatura no Laudo de Vistoria de Saída não exonera o LOCATÁRIO da responsabilidade pelos danos constatados e confirmados pela assinatura de duas testemunhas.'),
      subitem('Parágrafo quarto: havendo divergências entre as vistorias de entrada e saída, ou avarias que necessitem reparo, os danos deverão ser corrigidos pelo LOCATÁRIO, ficando a devolução das chaves condicionada ao efetivo reparo.'),
      subitem('Parágrafo quinto: é assegurado à ADMINISTRADORA o direito de vistoriar o imóvel sempre que conveniente, observado o disposto no art. 23, IX, da Lei nº 8.245/91.'),
      subitem('Parágrafo sexto: é proibido depositar materiais inflamáveis ou explosivos, bem como cortar árvores no imóvel locado, sob pena de responsabilização do LOCATÁRIO pelas perdas e danos causados.'),
      subitem('Parágrafo sétimo: as partes acordam a cobrança de taxa única de {taxa_vistoria_valor}, referente à elaboração do laudo de vistoria de entrada, sendo cobrado o mesmo valor na vistoria de saída.'),
      subitem('Parágrafo oitavo: o LOCATÁRIO fica obrigado a comunicar à ADMINISTRADORA, por e-mail ou outro meio, quaisquer problemas que afetem o imóvel e cuja responsabilidade seja do LOCADOR.'),
      clausula(6, 'da benfeitoria do imóvel', 'Durante a vigência deste contrato, o LOCATÁRIO somente poderá realizar obras no imóvel mediante prévia autorização, por escrito ou outro meio, da ADMINISTRADORA, ressalvadas as benfeitorias necessárias, que ficam sob sua responsabilidade: {benfeitorias_necessarias_locatario}.'),
      subitem('Parágrafo único: as benfeitorias introduzidas pelo LOCATÁRIO, sejam necessárias ou voluptuárias, serão incorporadas ao imóvel sem direito a indenização ou retenção, salvo as voluptuárias que não afetem substancialmente a estrutura do imóvel, que poderão ser retiradas pelo LOCATÁRIO.'),
      clausula(7, 'das despesas', 'Além do aluguel, compete ao LOCATÁRIO o pagamento das despesas ordinárias mensais de {despesas_ordinarias_locatario}, bem como de todos os tributos que incidam sobre o imóvel locado, sendo de sua responsabilidade eventuais multas por atraso ou não pagamento. {condominio_observacao}'),
      subitem('Parágrafo primeiro: as despesas ordinárias e o IPTU anual serão pagos pelo LOCATÁRIO diretamente aos órgãos responsáveis, devendo os comprovantes quitados ser apresentados à ADMINISTRADORA ao término do contrato.'),
      subitem('Parágrafo segundo: caso os encargos sejam quitados pela ADMINISTRADORA em razão do não pagamento pelo LOCATÁRIO nos prazos devidos, o valor será reembolsado por este, acrescido de 10% (dez por cento) de multa e juros de mora de 1% (um por cento) ao mês, com correção monetária pro rata.'),
      subitem('Parágrafo terceiro: o não pagamento dos encargos sob responsabilidade do LOCATÁRIO poderá ensejar ação de despejo por infração contratual, sujeitando-o ainda à multa prevista na CLÁUSULA DÉCIMA PRIMEIRA, independentemente do tempo decorrido do contrato.'),
      subitem('Parágrafo quarto: o LOCATÁRIO responsabiliza-se pela solicitação de fornecimento de energia elétrica, internet e gás para o imóvel, devendo tais serviços estar em seu nome. A não transferência da titularidade em até {prazo_transferencia_titularidade_dias} dias constitui infração contratual, sujeita à multa de {multa_transferencia_titularidade_percentual}% do aluguel vigente.'),
      clausula(8, 'do seguro contra incêndio e providências', 'O LOCATÁRIO deve contratar seguro contra incêndio no prazo de {prazo_seguro_incendio_horas} horas após a assinatura deste contrato, ou autoriza expressamente a ADMINISTRADORA a providenciar a contratação em seu nome, durante toda a vigência deste instrumento ou enquanto o LOCATÁRIO permanecer na posse do imóvel.'),
      subitem('Parágrafo primeiro: a apólice será emitida em nome do LOCADOR, cabendo ao LOCATÁRIO o pagamento do respectivo prêmio; o não pagamento não afasta sua responsabilidade por eventual sinistro, independentemente de apuração de culpa.'),
      subitem('Parágrafo segundo: em caso de incêndio causado pelo LOCATÁRIO, este responderá integralmente pelos danos causados.'),
      clausula(9, 'do condomínio', 'O LOCATÁRIO compromete-se a observar e cumprir o regulamento interno do condomínio, quando houver, estendendo essa obrigação a todos que, direta ou indiretamente, estejam ligados ao uso do imóvel.'),
      subitem('Parágrafo primeiro: multas condominiais decorrentes de infração ao regulamento interno ou às deliberações da assembleia serão de responsabilidade do LOCATÁRIO.'),
      subitem('Parágrafo segundo: as despesas extraordinárias de condomínio, nos termos do art. 22 da Lei nº 8.245/91, são de responsabilidade do LOCADOR; caso pagas pelo LOCATÁRIO, este terá prazo improrrogável de 30 (trinta) dias para apresentar o comprovante à ADMINISTRADORA, para o devido abatimento no aluguel do mês seguinte.'),
      clausula(10, 'da taxa de conservação do imóvel', 'O LOCATÁRIO fica isento do pagamento de taxa de conservação, responsabilizando-se, contudo, pelas benfeitorias necessárias já descritas na CLÁUSULA SEXTA e por quaisquer reparos a que der causa.'),
      subitem('Parágrafo único: o LOCATÁRIO desde já autoriza a ADMINISTRADORA, em caso de rescisão do contrato, a utilizar os valores pagos a título de caução para a execução dos reparos necessários à restituição do imóvel nas condições descritas no Laudo de Vistoria de Entrada, sem prejuízo do pagamento de eventuais diferenças apuradas.'),
      clausula(11, 'da multa pactuada e rescisão', 'Fica estipulada multa equivalente a {multa_rescisao_meses} meses de aluguel vigente na data da ocorrência, em caso de rescisão contratual antecipada por qualquer das partes.'),
      subitem('Parágrafo primeiro: em caso de rescisão, as partes deverão comunicar a intenção com {prazo_aviso_rescisao_dias} dias de antecedência do vencimento do próximo aluguel.'),
      subitem('Parágrafo segundo: em caso de rescisão por parte do LOCATÁRIO, este permanece responsável pelo pagamento do aluguel até o encerramento do prazo de aviso; ultrapassado esse prazo, permanecerá responsável até a efetiva saída.'),
      subitem('Parágrafo terceiro: não haverá multa rescisória caso o contrato seja rescindido no {meses_isencao_multa_rescisao} mês, desde que solicitado com {prazo_aviso_rescisao_dias} dias de antecedência.'),
      clausula(12, 'do abandono', 'Havendo indícios de abandono do imóvel, a ADMINISTRADORA poderá vistoriá-lo mediante presença de duas testemunhas, lavrando termo circunstanciado e adotando as medidas judiciais cabíveis.'),
      clausula(13, 'do falecimento', 'Em caso de falecimento do LOCATÁRIO, ficarão sub-rogados em seus direitos e obrigações o cônjuge ou companheiro(a) e, sucessivamente, os herdeiros. Em caso de divórcio ou dissolução de união estável, a locação prossegue automaticamente com quem permanecer no imóvel, devendo a sub-rogação ser comunicada por escrito.'),
      clausula(14, 'da comunicação', 'Quaisquer tolerâncias ou concessões da ADMINISTRADORA para com o LOCATÁRIO, quando não manifestadas por escrito ou outro meio, não constituirão precedente invocável nem terão o condão de alterar as obrigações contratuais.'),
      clausula(15, 'da desapropriação', 'Em caso de desapropriação do imóvel locado, o LOCADOR ficará desobrigado de todas as cláusulas deste contrato, reservando-se ao LOCATÁRIO tão somente a faculdade de reclamar do poder desapropriante a indenização a que porventura tiver direito.'),
      clausula(16, 'da venda', 'Em caso de venda do imóvel, o LOCATÁRIO terá direito de preferência, mediante envio de proposta pelo LOCADOR; o silêncio por mais de 5 (cinco) dias será considerado desinteresse na compra.'),
      subitem('Parágrafo primeiro: diante do desinteresse na aquisição, o LOCATÁRIO autoriza o LOCADOR a fixar placas no imóvel, dar publicidade à venda e apresentá-lo a interessados, sempre acompanhados de corretor credenciado.'),
      subitem('Parágrafo segundo: caso o imóvel seja vendido durante a locação, as partes ficam isentas de quaisquer ônus, e o LOCATÁRIO terá 30 (trinta) dias para desocupação, contados da assinatura do contrato de compra e venda.'),
      clausula(17, 'da caução', 'O LOCATÁRIO concorda em depositar, a título de garantia, caução no valor de R$ {valor_caucao} ({valor_caucao_extenso}), pago {forma_pagamento_caucao}, em {data_pagamento_caucao}.'),
      subitem('Parágrafo primeiro: finalizado ou rescindido o contrato, será deduzido do valor depositado o montante necessário à quitação de débitos deixados pelo LOCATÁRIO.'),
      subitem('Parágrafo segundo: a ADMINISTRADORA se compromete a devolver o valor total ao LOCATÁRIO, desde que o imóvel seja restituído conforme o Laudo de Vistoria de Entrada, no prazo de {prazo_devolucao_caucao_dias} dias úteis após o término do contrato.'),
      subitem('Parágrafo terceiro: é vedado o uso dos valores de caução para pagamento de aluguéis ou quaisquer taxas por parte do LOCATÁRIO durante a vigência deste contrato.'),
      clausula(18, 'da privacidade de dados', 'A ADMINISTRADORA se responsabiliza pela confidencialidade e sigilo dos dados pessoais a que tenha acesso em razão deste contrato, devendo assegurar que seus prestadores de serviço observem o mesmo dever de sigilo, sem compartilhar dados com terceiros sem ciência do LOCATÁRIO. O LOCATÁRIO autoriza a ADMINISTRADORA a cadastrar seus dados em sistema próprio para gestão da locação e emissão de boleto.'),
      clausula(19, 'da comunicação entre locador e locatário', 'A comunicação entre LOCADOR e LOCATÁRIO se dará exclusivamente por intermédio da ADMINISTRADORA {imobiliaria_nome}, comprometendo-se as partes a priorizar as comunicações através dela.'),
      clausula(20, 'da responsabilidade por animais', 'O LOCATÁRIO responderá integralmente por danos causados por animais de sua propriedade ou sob sua guarda.'),
      clausula(21, 'da sublocação', 'É vedada a cessão, o empréstimo ou a sublocação, total ou parcial, do imóvel, sem autorização expressa e escrita do LOCADOR.'),
      clausula(22, 'do uso do imóvel', 'O imóvel destina-se exclusivamente à moradia residencial, sendo vedado o exercício de atividades comerciais sem autorização expressa.'),
      clausula(23, 'da comprovação de renda e informações cadastrais', 'O LOCATÁRIO compromete-se a manter seus dados cadastrais atualizados durante toda a vigência da locação.'),
      clausula(24, 'da entrega das chaves', 'A locação somente será considerada encerrada após a efetiva entrega das chaves e assinatura do termo de devolução/vistoria de saída.'),
      clausula(25, 'do acordo extrajudicial', 'Qualquer parcelamento ou acordo firmado entre as partes não importará novação da dívida, permanecendo íntegras as demais cláusulas contratuais.'),
      clausula(26, 'das notificações', 'As partes reconhecem a validade de notificações encaminhadas por WhatsApp, e-mail ou plataforma eletrônica indicada pela ADMINISTRADORA.'),
      clausula(27, 'da retomada antecipada do imóvel pelo locador', 'A presente locação é celebrada por prazo determinado de {prazo_meses} meses, comprometendo-se as partes a respeitar integralmente sua vigência. Durante o prazo contratual, o LOCADOR somente poderá reaver o imóvel nas hipóteses expressamente previstas na Lei nº 8.245/91, especialmente: (I) por mútuo acordo entre as partes; (II) em decorrência de infração legal ou contratual praticada pelo LOCATÁRIO; (III) por falta de pagamento dos aluguéis, encargos ou demais obrigações pecuniárias assumidas neste contrato; (IV) para realização de reparações urgentes determinadas pelo Poder Público que não possam ser executadas com a permanência do LOCATÁRIO, ou que este se recuse a consentir; (V) nas demais hipóteses de retomada previstas na legislação aplicável.'),
      subitem('Parágrafo único: ocorrendo qualquer das hipóteses acima, o LOCADOR poderá promover as medidas judiciais cabíveis para retomada do imóvel, observados os prazos, notificações e demais requisitos legais.'),
      clausula(28, 'do foro e da assinatura eletrônica', 'O presente contrato passa a vigorar entre as partes a partir de {data_inicio}. Para dirimir dúvidas emergentes deste contrato, elege-se o foro da comarca de {cidade_contrato}, com renúncia expressa a qualquer outro, por mais privilegiado que seja.'),
      par('E, por estarem assim justas e contratadas, as partes firmam o presente instrumento por meio de assinatura presencial ou eletrônica, em vias de igual teor e forma, na presença das testemunhas abaixo, obrigando-se por si e seus herdeiros e/ou sucessores ao fiel cumprimento de todas as cláusulas e condições aqui listadas.', { margin: [0, 14, 0, 0] }),
      assinaturas(['{locatario_nome}', '{#tem_locatario2}{locatario2_nome}{/tem_locatario2}', '{#tem_locatario3}{locatario3_nome}{/tem_locatario3}', 'PELA ADMINISTRADORA — {imobiliaria_nome}']),
      testemunhas(),
      disclaimer(),
    ],

    // 1B. CONTRATO DE LOCAÇÃO COMERCIAL (modelo próprio Gregório | Meu Lar — 21 cláusulas)
    locacao_comercial: [
      titulo('CONTRATO DE LOCAÇÃO COMERCIAL'),
      identificacao(),
      labelPar('LOCADOR(A):', '{locador_nome}, {locador_nacionalidade}, {locador_estado_civil}, {locador_profissao}, portador(a) do CPF/CNPJ nº {locador_cpf}, residente e domiciliado(a) em {locador_endereco}, neste ato representado(a) pela ADMINISTRADORA {imobiliaria_nome}, CRECI {imobiliaria_creci}, por meio do(a) corretor(a) {corretor_nome} (CRECI {corretor_creci}), doravante denominada simplesmente ADMINISTRADORA.'),
      labelPar('LOCATÁRIO(A) 1:', '{locatario_nome}, {locatario_nacionalidade}, {locatario_estado_civil}, {locatario_profissao}, portador(a) do RG nº {locatario_rg} e CPF nº {locatario_cpf}, residente e domiciliado(a) em {locatario_endereco}, telefone {locatario_telefone}, e-mail {locatario_email}.'),
      par('{#tem_locatario2}LOCATÁRIO(A) 2: {locatario2_nome}, {locatario2_nacionalidade}, {locatario2_estado_civil}, {locatario2_profissao}, portador(a) do RG nº {locatario2_rg} e CPF nº {locatario2_cpf}, residente e domiciliado(a) em {locatario2_endereco}, telefone {locatario2_telefone}, e-mail {locatario2_email}.{/tem_locatario2}'),
      labelPar('IMÓVEL LOCADO:', 'imóvel comercial com área total de {imovel_area_total} m² ({imovel_dimensoes}) e área construída de {imovel_area_construida} m², localizado em {imovel_endereco_completo}, inscrição fiscal {imovel_inscricao_fiscal}, matrícula nº {imovel_matricula}.'),
      par('PREÂMBULO. Por este instrumento particular, as partes acima qualificadas ajustam o presente CONTRATO DE LOCAÇÃO DE IMÓVEL PARA FINS COMERCIAIS, na forma da Lei nº 8.245/91, mediante as cláusulas e condições a seguir, que voluntariamente aceitam e outorgam.', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do objeto', 'O imóvel acima descrito destina-se exclusivamente a fins comerciais, no ramo de atividade de {ramo_atividade}, não podendo ter sua destinação alterada sem prévia anuência escrita da ADMINISTRADORA.'),
      clausula(2, 'do prazo', 'A presente locação terá início em {data_inicio} e término em {data_termino}, pelo prazo de {prazo_meses} meses, podendo ser rescindida sem multa por ambas as partes após o pagamento de {mes_resilicao_sem_multa} meses de aluguel, hipótese em que o LOCATÁRIO se obriga a restituir o imóvel desocupado, em {prazo_aviso_desocupacao_dias} dias, em perfeito estado de conservação, tal como consta do Laudo de Vistoria de Entrada. Findo o prazo, o contrato terá renovação automática por mais {renovacao_automatica_anos} ano(s), sucessivamente, observados os reajustes de aluguel.'),
      clausula(3, 'do valor', 'O valor do aluguel, inicial e livremente convencionado, é de R$ {valor_aluguel} ({valor_aluguel_extenso}), a ser pago pelo LOCATÁRIO através de boleto bancário ou depósito/transferência em conta indicada pela ADMINISTRADORA.'),
      subitem('Parágrafo primeiro: o boleto será enviado ao LOCATÁRIO com {dias_antecedencia_boleto} dias de antecedência do vencimento, por WhatsApp ou outro meio; na ausência de recebimento, o LOCATÁRIO deverá solicitá-lo junto à ADMINISTRADORA, no endereço constante no rodapé deste instrumento.'),
      subitem('Parágrafo segundo: o LOCATÁRIO fica ciente de que será cobrado, junto ao boleto de aluguel, o valor de {taxa_emissao_boleto} referente à emissão do título.'),
      subitem('Parágrafo terceiro: o aluguel será reajustado anualmente pelo índice {indice_reajuste}, ou outro índice oficial que venha a substituí-lo; caso o novo índice corrija o aluguel para valor menor, o aluguel será reajustado em {reajuste_piso_percentual}% sobre o valor atual.'),
      subitem('Parágrafo quarto: o cálculo do mês de locação será baseado na data de vencimento do aluguel, podendo o primeiro aluguel ser maior, a depender da data de início da locação.'),
      clausula(4, 'do atraso no pagamento de aluguel', 'Os aluguéis pagos fora do prazo estipulado na cláusula anterior serão acrescidos de multa de {multa_atraso_percentual}% (por cento), juros moratórios de {juros_mora_percentual}% ao mês e correção monetária pro rata tempore, calculados sobre o valor do aluguel.'),
      subitem('Parágrafo primeiro: decorridos {prazo_honorarios_dias} dias corridos após o vencimento, além dos acréscimos acima, o LOCATÁRIO pagará honorários advocatícios na base de {honorarios_atraso_percentual}% sobre o valor do débito, mesmo que a cobrança seja extrajudicial, sem prejuízo das custas processuais em caso de demanda judicial.'),
      subitem('Parágrafo segundo: o inadimplemento dos aluguéis e/ou encargos faculta à ADMINISTRADORA, no prazo de 5 (cinco) dias após notificação prévia, incluir os dados do LOCATÁRIO nos serviços de proteção ao crédito, cabendo a este o pagamento de todas as despesas de reabilitação decorrentes, que ocorrerá somente após a quitação integral dos débitos.'),
      subitem('Parágrafo terceiro: o LOCATÁRIO tem ciência de que os direitos creditórios decorrentes deste contrato poderão ser cedidos a empresas de cobrança, ficando o cessionário autorizado a praticar os atos necessários à cobrança, negativação ou protesto para preservação dos direitos cedidos.'),
      clausula(5, 'das condições e vistoria do imóvel', 'O imóvel será entregue mediante Laudo de Vistoria de Entrada detalhado, com descrição minuciosa e registro fotográfico, elaborado pela ADMINISTRADORA, que passa a integrar este contrato.'),
      subitem('Parágrafo primeiro: fica estipulado o prazo de {prazo_contestacao_vistoria_dias} dias corridos, contados da assinatura deste instrumento, para contestação do Laudo de Vistoria de Entrada, por WhatsApp ou e-mail junto à ADMINISTRADORA.'),
      subitem('Parágrafo segundo: na Vistoria de Saída também é facultado o comparecimento do LOCATÁRIO; caso as chaves sejam restituídas por pessoa diversa, esta fica autorizada a assinar o Laudo de Vistoria de Saída em nome daquele.'),
      subitem('Parágrafo terceiro: a ausência de assinatura no Laudo de Vistoria de Saída não exonera o LOCATÁRIO da responsabilidade pelos danos constatados e confirmados pela assinatura de duas testemunhas.'),
      subitem('Parágrafo quarto: havendo divergências entre as vistorias de entrada e saída, ou avarias que necessitem reparo, os danos deverão ser corrigidos pelo LOCATÁRIO, ficando a devolução das chaves condicionada ao efetivo reparo.'),
      subitem('Parágrafo quinto: é assegurado à ADMINISTRADORA o direito de vistoriar o imóvel sempre que conveniente, observado o disposto no art. 23, IX, da Lei nº 8.245/91.'),
      subitem('Parágrafo sexto: é proibido depositar materiais inflamáveis ou explosivos, bem como cortar árvores no imóvel locado, sob pena de responsabilização do LOCATÁRIO pelas perdas e danos causados.'),
      subitem('Parágrafo sétimo: as partes acordam a cobrança de taxa única de {taxa_vistoria_valor}, referente à elaboração do laudo de vistoria de entrada, sendo cobrado o mesmo valor na vistoria de saída.'),
      subitem('Parágrafo oitavo: o LOCATÁRIO fica obrigado a comunicar ao proprietário, por meio da ADMINISTRADORA, via WhatsApp ou e-mail, quaisquer problemas que afetem o imóvel e cuja responsabilidade a este incumba.'),
      clausula(6, 'da benfeitoria do imóvel', 'Durante a vigência deste contrato, o LOCATÁRIO somente poderá realizar obras no imóvel mediante prévia autorização da ADMINISTRADORA, ressalvadas as benfeitorias necessárias, que ficam sob sua responsabilidade, obrigando-se, findo o contrato, a devolver o imóvel nas mesmas condições em que o recebeu.'),
      subitem('Parágrafo único: as benfeitorias voluptuárias poderão ser retiradas pelo LOCATÁRIO ao final do contrato, desde que não causem danos ao imóvel.'),
      clausula(7, 'das despesas', 'Além do aluguel, compete ao LOCATÁRIO o pagamento das despesas ordinárias de {despesas_ordinarias_locatario}, bem como de todos os tributos que incidam sobre o imóvel locado, sendo de sua responsabilidade eventuais multas por atraso ou não pagamento.'),
      subitem('Parágrafo primeiro: as despesas ordinárias de condomínio, se houver, serão pagas pelo LOCATÁRIO aos agentes cobradores e/ou órgãos responsáveis, devendo os comprovantes quitados ser apresentados à ADMINISTRADORA ao término do contrato, por e-mail ou correio, com as devidas especificações do imóvel.'),
      subitem('Parágrafo segundo: caso os encargos sejam quitados pela ADMINISTRADORA em razão do não pagamento pelo LOCATÁRIO nos prazos devidos, o valor será reembolsado por este, acrescido de 10% (dez por cento) de multa e juros de mora de 1% (um por cento) ao mês, com correção monetária pro rata.'),
      subitem('Parágrafo terceiro: o não pagamento dos encargos sob responsabilidade do LOCATÁRIO poderá ensejar ação de despejo por infração contratual, sujeitando-o ainda à multa prevista na CLÁUSULA DÉCIMA PRIMEIRA, independentemente do tempo decorrido do contrato.'),
      subitem('Parágrafo quarto: o LOCATÁRIO responsabiliza-se pela solicitação de fornecimento de água, luz e gás para o imóvel, devendo tais serviços estar em seu nome, estando presente para receber os colaboradores das concessionárias. {consequencia_nao_transferencia}'),
      clausula(8, 'do seguro contra incêndio e providências', 'O LOCATÁRIO fica responsável por providenciar a contratação de seguro contra incêndio, inundação e vendaval que possam acometer o imóvel e suas benfeitorias, durante toda a vigência deste instrumento ou enquanto permanecer na posse do imóvel.'),
      subitem('Parágrafo primeiro: a apólice será emitida em nome do LOCADOR, cabendo ao LOCATÁRIO o pagamento do respectivo prêmio; o não pagamento não afasta sua responsabilidade por eventual sinistro, independentemente de apuração de culpa.'),
      subitem('Parágrafo segundo: em caso de incêndio causado pelo LOCATÁRIO, este responderá integralmente pelos danos causados.'),
      clausula(9, 'do condomínio', 'O LOCATÁRIO compromete-se a observar e cumprir o regulamento interno do condomínio, quando houver, estendendo essa obrigação a todos que, direta ou indiretamente, estejam ligados ao uso do imóvel.'),
      subitem('Parágrafo primeiro: multas condominiais decorrentes de infração ao regulamento interno ou às deliberações da assembleia serão de responsabilidade do LOCATÁRIO.'),
      subitem('Parágrafo segundo: as despesas extraordinárias de condomínio, nos termos do art. 22 da Lei nº 8.245/91, são de responsabilidade da ADMINISTRADORA/LOCADOR; caso pagas pelo LOCATÁRIO, este terá prazo improrrogável de 30 (trinta) dias para apresentar o comprovante à ADMINISTRADORA, para o devido abatimento no aluguel do mês seguinte.'),
      clausula(10, 'da taxa de conservação do imóvel', 'Acordam as partes que o LOCATÁRIO fica desobrigado de efetuar o pagamento de percentual para manutenção do imóvel.'),
      clausula(11, 'da multa pactuada e rescisão', 'O presente contrato poderá ser rescindido por qualquer das partes mediante aviso prévio de {prazo_aviso_rescisao_dias} dias, por escrito. Em caso de rescisão antecipada pelo LOCATÁRIO, será devida multa proporcional ao tempo restante do contrato, calculada sobre o valor de {multa_rescisao_meses} aluguéis, conforme a Lei do Inquilinato. Não será devida multa em caso de transferência profissional do LOCATÁRIO para outra localidade, mediante comprovação.'),
      subitem('Parágrafo primeiro: em caso de rescisão por parte do LOCATÁRIO, este deverá avisar a LOCADORA com {prazo_aviso_rescisao_dias} dias de antecedência do vencimento do próximo aluguel, ficando responsável pelo pagamento do aluguel até o encerramento do prazo; ultrapassado esse prazo, permanecerá responsável até a efetiva saída.'),
      subitem('Parágrafo segundo: não haverá multa rescisória caso este contrato seja rescindido após o {mes_isencao_multa_rescisao} mês, desde que solicitado com {prazo_aviso_rescisao_dias} dias de antecedência.'),
      clausula(12, 'do abandono', 'Na hipótese de o LOCATÁRIO abandonar o imóvel, fica a ADMINISTRADORA autorizada a reintegrar-se na posse, a fim de evitar depredação ou invasão do mesmo.'),
      clausula(13, 'do falecimento', 'Em caso de falecimento do LOCATÁRIO, ficarão sub-rogados em seus direitos e obrigações o cônjuge ou companheiro(a) e, sucessivamente, os herdeiros. Em caso de divórcio ou dissolução de união estável, a locação prossegue automaticamente com quem permanecer no imóvel, devendo a sub-rogação ser comunicada por escrito.'),
      clausula(14, 'da comunicação', 'Quaisquer tolerâncias ou concessões da ADMINISTRADORA para com o LOCATÁRIO, quando não manifestadas por escrito, não constituirão precedente invocável nem terão o condão de alterar as obrigações contratuais.'),
      clausula(15, 'da desapropriação', 'Em caso de desapropriação do imóvel locado, o LOCADOR ficará desobrigado de todas as cláusulas deste contrato, reservando-se ao LOCATÁRIO tão somente a faculdade de reclamar do poder desapropriante a indenização a que porventura tiver direito.'),
      clausula(16, 'da venda', 'Em caso de venda do imóvel, o LOCATÁRIO terá direito de preferência mediante envio de proposta pelo LOCADOR; o não envio de manifestação no prazo de {prazo_direito_preferencia_dias} dias será considerado desinteresse na compra.'),
      subitem('Parágrafo primeiro: diante do desinteresse na aquisição, o LOCATÁRIO autoriza o LOCADOR a fixar placas no imóvel, dar publicidade à venda e apresentá-lo a interessados, sempre acompanhados de corretor credenciado.'),
      subitem('Parágrafo segundo: em caso de venda do imóvel, o presente contrato será respeitado pelo adquirente até o término do prazo contratual, nos termos do art. 8º da Lei nº 8.245/91, desde que devidamente averbado na matrícula do imóvel, podendo o adquirente denunciar o contrato e conceder prazo mínimo de {prazo_desocupacao_pos_venda_dias} dias para desocupação.'),
      clausula(17, 'da caução', 'O LOCATÁRIO concorda em depositar, a título de garantia, caução no valor de R$ {valor_caucao} ({valor_caucao_extenso}), pago {forma_pagamento_caucao}.'),
      subitem('Parágrafo primeiro: finalizado ou rescindido o contrato, será deduzido do valor depositado o montante necessário à quitação de débitos deixados pelo LOCATÁRIO.'),
      subitem('Parágrafo segundo: o valor dado em caução será devolvido ao LOCATÁRIO ao término da locação, após a quitação de todas as obrigações contratuais, corrigido monetariamente pelo índice {indice_correcao_caucao}, ou outro índice oficial que o substitua.'),
      subitem('Parágrafo terceiro: é vedado o uso dos valores de caução para pagamento de aluguéis ou quaisquer taxas por parte do LOCATÁRIO durante a vigência deste contrato.'),
      subitem('Parágrafo quarto: o LOCATÁRIO desde já autoriza a ADMINISTRADORA, em caso de rescisão do contrato, a utilizar os valores pagos a título de caução para a execução dos reparos necessários à restituição do imóvel nas condições descritas no relatório de vistoria inicial, sem prejuízo do pagamento de eventuais diferenças apuradas, conforme disposto na Lei nº 8.245/91.'),
      clausula(18, 'da privacidade de dados', 'A ADMINISTRADORA se responsabiliza pela confidencialidade e sigilo dos dados pessoais a que tenha acesso em razão deste contrato, devendo assegurar que seus prestadores de serviço observem o mesmo dever de sigilo, sem compartilhar dados com terceiros sem ciência do LOCATÁRIO. O LOCATÁRIO autoriza a ADMINISTRADORA a cadastrar seus dados em sistema próprio para gestão da locação e emissão de boleto.'),
      clausula(19, 'da comunicação entre locador e locatário', 'As comunicações entre as partes poderão ser realizadas por meio da ADMINISTRADORA, ou presencialmente entre LOCADOR e LOCATÁRIO, em reunião com a presença de representante da ADMINISTRADORA.'),
      subitem('Parágrafo único: o não cumprimento desta cláusula acarretará multa de {multa_comunicacao_meses} vezes o valor do aluguel vigente à época da ocorrência, a ser paga pela parte infratora, ficando afastada a multa quando a comunicação direta e presencial ocorrer com a presença da ADMINISTRADORA.'),
      clausula(20, 'da utilização', 'O imóvel será locado exclusivamente para fins comerciais.'),
      subitem('Parágrafo primeiro: a instalação de placas, cartazes, inscrições, aparelhos de ar condicionado, antenas e outros na parte externa do imóvel deverá ser previamente acordada com o LOCADOR quanto ao local apropriado, observado o regulamento interno do edifício, quando houver.'),
      subitem('Parágrafo segundo: o LOCADOR não responderá, em nenhum caso, por danos sofridos pelo LOCATÁRIO em razão de derramamento de líquidos, rompimento de canos, aberturas de torneiras, incêndio, casos fortuitos ou de força maior.'),
      subitem('Parágrafo terceiro: o LOCATÁRIO não terá direito à retenção do pagamento do aluguel ou de qualquer quantia devida, sob alegação de exigências não atendidas.'),
      subitem('Parágrafo quarto: o LOCATÁRIO não poderá escusar-se do pagamento de diferenças de aluguéis, impostos, taxas condominiais ou outros ônus, mesmo sob alegação de que o pagamento não lhe foi exigido na época fixada neste contrato.'),
      clausula(21, 'do foro', 'O presente contrato passa a vigorar entre as partes a partir de {data_inicio}, elegendo as partes o foro da comarca de {cidade_contrato} para dirimir quaisquer dúvidas provenientes da execução e cumprimento deste instrumento, com renúncia a qualquer outro, por mais privilegiado que seja.'),
      par('E, por estarem assim justas e contratadas, as partes firmam o presente instrumento em vias de igual teor e forma, na presença das testemunhas abaixo, para que surta seus legais e jurídicos efeitos, obrigando-se por si e seus herdeiros e/ou sucessores ao fiel cumprimento de todas as cláusulas e condições listadas neste contrato, ficando assim irrevogável.', { margin: [0, 14, 0, 0] }),
      assinaturas(['{locatario_nome}', '{#tem_locatario2}{locatario2_nome}{/tem_locatario2}', 'PELA ADMINISTRADORA — {imobiliaria_nome}']),
      testemunhas(),
      disclaimer(),
    ],

    // 2. CONTRATO DE COMPRA E VENDA DE IMÓVEL (modelo próprio Gregório | Meu Lar — 13 cláusulas)
    compra_venda: [
      titulo('CONTRATO DE COMPRA E VENDA DE IMÓVEL COM PRINCÍPIO DE PAGAMENTO'),
      identificacao(),
      labelPar('PROPONENTE VENDEDOR(A):', '{vendedor_nome}, {vendedor_nacionalidade}, {vendedor_estado_civil}, {vendedor_profissao}, portador(a) do RG nº {vendedor_rg} e CPF nº {vendedor_cpf}, residente e domiciliado(a) em {vendedor_endereco}.'),
      labelPar('PROPONENTE COMPRADOR(A) 1:', '{comprador_nome}, {comprador_nacionalidade}, {comprador_estado_civil}, {comprador_profissao}, portador(a) do RG nº {comprador_rg} e CPF nº {comprador_cpf}, residente e domiciliado(a) em {comprador_endereco}.'),
      par('{#tem_comprador2}PROPONENTE COMPRADOR(A) 2: {comprador2_nome}, {comprador2_nacionalidade}, {comprador2_estado_civil}, {comprador2_profissao}, portador(a) do RG nº {comprador2_rg} e CPF nº {comprador2_cpf}, residente e domiciliado(a) em {comprador2_endereco}.{/tem_comprador2}'),
      labelPar('DO IMÓVEL:', 'imóvel do tipo {imovel_tipo}, {imovel_descricao_detalhada}, com área construída de {imovel_area_construida} m², localizado em {imovel_endereco_completo}, registrado sob a matrícula nº {imovel_matricula}.'),
      clausula(1, 'do objeto', 'O(A) VENDEDOR(A) vende ao(à) COMPRADOR(A), que compra, de forma livre e espontânea, o imóvel acima descrito, declarando estar o mesmo livre e desembaraçado de quaisquer ônus, dívidas, hipotecas, penhoras ou pendências judiciais, respondendo o(a) VENDEDOR(A) pela evicção nos termos dos arts. 447 a 457 do Código Civil.'),
      clausula(2, 'do valor de venda e das condições de pagamento', 'O imóvel é vendido pelo valor de R$ {valor_venda} ({valor_venda_extenso}), a ser pago nas seguintes condições: {condicoes_pagamento}'),
      clausula(3, 'das arras', 'O presente negócio é realizado de acordo com o art. 420 do Código Civil, sendo que o sinal de negócio faz parte dos honorários da imobiliária pela sua intermediação. Havendo arrependimento por parte do(a) COMPRADOR(A), este(a) perderá o sinal de negócio em favor do(a) VENDEDOR(A); havendo arrependimento por parte do(a) VENDEDOR(A), este(a) deverá devolver ao(à) COMPRADOR(A) o valor do sinal de negócio recebido pela imobiliária, mais o seu equivalente.'),
      clausula(4, 'da proposta', 'A proposta será encaminhada pela intermediária ao(à) VENDEDOR(A), podendo ser aceita, recusada ou apresentada contraproposta ao(à) PROPONENTE COMPRADOR(A).'),
      clausula(5, 'do aceite', 'Sendo aceita, a presente PROPOSTA DE COMPRA E VENDA COM SINAL DE NEGÓCIO E PRINCÍPIO DE PAGAMENTO passa a ter caráter irrevogável e irretratável.'),
      subitem('Parágrafo primeiro: o valor recebido como sinal de negócio e princípio de pagamento fará parte do pagamento do preço estipulado, aplicando-se o disposto nos arts. 418 e 419 do Código Civil.'),
      subitem('Parágrafo segundo: caso o sinal de negócio seja pago em cheque, este terá caráter pró-solvendo, dando-se por quitado somente após a compensação bancária.'),
      clausula(6, 'da recusa', 'Recusada a presente proposta, o(a) PROPONENTE COMPRADOR(A) reaverá integralmente o valor do sinal, sem quaisquer acréscimos, desobrigando-se definitivamente nos termos e condições propostas.'),
      clausula(7, 'das despesas de transferência', 'As despesas decorrentes da transferência do imóvel — escritura, Funrejus, certidões, ITBI, registro de imóvel, além das de obtenção ou transferência de financiamento, abertura de crédito, documentação e outras — são de responsabilidade do(a) PROPONENTE COMPRADOR(A).'),
      clausula(8, 'da documentação e dos esclarecimentos', 'O(A) PROPONENTE COMPRADOR(A) se obriga a apresentar os documentos necessários à lavratura da escritura, do compromisso de compra e venda e/ou do financiamento bancário no prazo de {prazo_documentos_dias} dias, contados do aceite da proposta, declarando ter recebido do(a) Corretor(a) de Imóveis todos os esclarecimentos referentes a eventuais ônus do imóvel, conforme o art. 723 e parágrafo único do Código Civil.'),
      clausula(9, 'da responsabilidade e da posse', 'O(A) COMPRADOR(A) declara estar ciente de que, a partir da data do recebimento das chaves, será civil e penalmente responsável pelo imóvel, isentando o(a) VENDEDOR(A) de danos a que der causa com a sua utilização.'),
      clausula(10, 'dos impostos e taxas incidentes sobre o imóvel', '{situacao_iptu} Os impostos e taxas devidos até a finalização da transação são de inteira responsabilidade do(a) VENDEDOR(A); a partir da data da posse, passam a ser de responsabilidade do(a) COMPRADOR(A).'),
      clausula(11, 'da responsabilidade das partes contratantes', 'As partes declaram ser de sua inteira responsabilidade a validade e a autenticidade de todos os documentos exigidos e apresentados, bem como das declarações prestadas, não possuindo informações cadastrais negativas ou medidas judiciais/extrajudiciais que comprometam sua solvabilidade, obrigando-se por si, seus herdeiros ou sucessores a cumprir tudo o quanto foi acordado neste instrumento.'),
      subitem('Parágrafo primeiro: as chaves do imóvel serão definitivamente do(a) COMPRADOR(A) em {prazo_chaves_pos_escritura_dias} dias corridos após a conclusão da transferência de escritura em cartório. O(A) VENDEDOR(A) declara estar ciente de que o pagamento final será realizado pelo(a) COMPRADOR(A) após a assinatura da transferência de escritura, podendo ocorrer em prazo de até {prazo_pagamento_final_dias} dia(s), a depender da efetiva conclusão da transferência junto ao Cartório de Notas.'),
      subitem('Parágrafo segundo: a responsabilidade pelo pagamento da comissão imobiliária devida a {imobiliaria_nome}, CNPJ {imobiliaria_cnpj}, endereço {imobiliaria_endereco_completo}, no valor de honorários de R$ {valor_comissao}, é do(a) VENDEDOR(A), que desde já autoriza a retirada de parte ou da totalidade deste valor a partir do sinal de negócio.'),
      clausula(12, 'da eleição do foro', 'Fica eleito o foro da comarca de {cidade_contrato} para dirimir dúvidas e/ou discutir qualquer ação oriunda deste contrato, com prévia renúncia a qualquer outro, por mais privilegiado que seja, obrigando-se a parte vencida a pagar, em caso de demanda judicial, as custas e honorários advocatícios da parte vencedora, na base de {honorarios_foro_percentual}% sobre o total do presente.'),
      par('E, por estarem justos e contratados, assinam o presente compromisso em vias de igual teor e forma, na presença das testemunhas instrumentais.', { margin: [0, 14, 0, 0] }),
      assinaturas(['VENDEDOR(A) — {vendedor_nome}', 'COMPRADOR(A) 1 — {comprador_nome}', '{#tem_comprador2}COMPRADOR(A) 2 — {comprador2_nome}{/tem_comprador2}', 'PELA ADMINISTRADORA — {imobiliaria_nome}']),
      testemunhas(),
      disclaimer(),
    ],

    // 3. PROPOSTA DE COMPRA COM SINAL DE RESERVA (modelo próprio Gregório | Meu Lar)
    proposta_compra: [
      titulo('PROPOSTA DE COMPRA E VENDA COM SINAL DE RESERVA'),
      identificacao(),
      labelPar('TIPO DE IMÓVEL:', '{imovel_tipo}, localizado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}.'),
      labelPar('PROPRIETÁRIO(A):', '{vendedor_nome}.'),
      labelPar('PROPONENTE (comprador(a)):', '{proponente_nome}, {proponente_nacionalidade}, {proponente_estado_civil}, {proponente_profissao}, portador(a) do RG nº {proponente_rg} e CPF nº {proponente_cpf}, residente e domiciliado(a) em {proponente_endereco}, telefone {proponente_telefone}, e-mail {proponente_email}.'),
      labelPar('OBSERVAÇÕES GERAIS DA VENDA:', '{observacoes_gerais_venda}'),
      par('O(A) PROPONENTE acima qualificado(a) apresenta, por intermédio de {imobiliaria_nome}, CRECI {imobiliaria_creci}, através do(a) corretor(a) {corretor_nome} (CRECI {corretor_creci}), a presente proposta de compra do imóvel acima descrito, nos termos seguintes:', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do valor da proposta', 'O valor proposto para a compra é de R$ {valor_proposta} ({valor_proposta_extenso}).'),
      clausula(2, 'do sinal de negócio', 'Junto com esta proposta, o(a) PROPONENTE entrega, a título de sinal de negócio e princípio de pagamento, o valor de R$ {valor_sinal} ({percentual_sinal}% do valor da proposta), que ficará sob a administração de {imobiliaria_nome} até a manifestação do(a) VENDEDOR(A).'),
      clausula(3, 'da documentação', 'A documentação relativa à transferência do imóvel será paga por: {responsavel_documentacao}.'),
      clausula(4, 'da renda comprovada', '{renda_comprovada}'),
      clausula(5, 'das arras', 'O presente negócio é realizado de acordo com o art. 420 do Código Civil, sendo que o sinal de negócio faz parte dos honorários da imobiliária pela sua intermediação. Havendo arrependimento por parte do(a) Comprador(a), este(a) perderá o sinal de negócio em favor do(a) Vendedor(a); havendo arrependimento por parte do(a) Vendedor(a), este(a) deverá devolver ao(à) Comprador(a) o valor do sinal de negócio ora recebido pela imobiliária, mais o seu equivalente.'),
      clausula(6, 'da proposta', 'A proposta será encaminhada pela INTERMEDIÁRIA ao PROPRIETÁRIO do imóvel, podendo ser aceita, recusada ou apresentada contraproposta ao PROPONENTE COMPRADOR.'),
      clausula(7, 'do aceite', 'Em sendo aceita, a presente PROPOSTA DE COMPRA E VENDA COM SINAL DE NEGÓCIO E PRINCÍPIO DE PAGAMENTO passa a ter caráter irrevogável e irretratável.'),
      subitem('Parágrafo primeiro: o valor pago como sinal de negócio e princípio de pagamento fará parte do pagamento do preço estipulado, aplicando-se o disposto nos arts. 418 e 419 do Código Civil.'),
      subitem('Parágrafo segundo: caso seja utilizado cheque referente ao sinal de negócio, este terá caráter pró-solvendo, dando-se por quitado somente após compensação bancária.'),
      clausula(8, 'da recusa', 'Recusada a presente proposta, o PROPONENTE COMPRADOR reaverá integralmente o valor de sinal, sem quaisquer acréscimos, desobrigando-se definitivamente nos termos e condições propostas.'),
      clausula(9, 'dos esclarecimentos sobre o imóvel', 'O PROPONENTE COMPRADOR declara que recebeu todos os esclarecimentos do Corretor de Imóveis referentes a possíveis ônus do imóvel ora a ser adquirido, conforme prevê o art. 723 e parágrafo único do Código Civil.'),
      clausula(10, 'da proteção de dados', 'As partes autorizam o tratamento dos dados pessoais constantes deste documento pela imobiliária interveniente, exclusivamente para as finalidades relacionadas a esta proposta, nos termos da Lei nº 13.709/2018 (LGPD).'),
      clausula(11, 'do foro', 'Fica eleito o foro da comarca de {cidade_contrato} para dirimir quaisquer dúvidas oriundas deste documento.'),
      par('E, por estarem assim justos, firmam a presente proposta em vias de igual teor e forma, na presença das testemunhas abaixo.', { margin: [0, 14, 0, 0] }),
      assinaturas(['COMPRADOR — {proponente_nome}', 'CORRETOR — {corretor_nome}', 'IMOBILIÁRIA INTERVENIENTE — {imobiliaria_nome}']),
      testemunhas(),
      disclaimer(),
    ],

    // 3-B. PROPOSTA DE COMPRA COM SINAL DE RESERVA — IMÓVEL NA PLANTA (vendedora = incorporadora/construtora)
    proposta_compra_planta: [
      titulo('PROPOSTA DE COMPRA E VENDA COM SINAL DE RESERVA — IMÓVEL NA PLANTA'),
      identificacao(),
      labelPar('INCORPORADORA/CONSTRUTORA (VENDEDORA):', '{construtora_razao_social}, CNPJ nº {construtora_cnpj}, com sede em {construtora_endereco}, neste ato representada por {construtora_representante_nome}, CPF nº {construtora_representante_cpf}.'),
      labelPar('PROPONENTE (comprador(a)):', '{proponente_nome}, {proponente_nacionalidade}, {proponente_estado_civil}, {proponente_profissao}, portador(a) do RG nº {proponente_rg} e CPF nº {proponente_cpf}, residente e domiciliado(a) em {proponente_endereco}, telefone {proponente_telefone}, e-mail {proponente_email}.'),
      labelPar('EMPREENDIMENTO:', '{nome_empreendimento}, situado em {endereco_empreendimento}, registro de incorporação nº {registro_incorporacao}.'),
      labelPar('UNIDADE OBJETO DA PROPOSTA:', 'unidade nº {numero_unidade}{#bloco_torre_pavimento}, {bloco_torre_pavimento}{/bloco_torre_pavimento}, com área privativa aproximada de {area_privativa_m2} m²{#vaga_garagem}, {vaga_garagem}{/vaga_garagem}.'),
      labelPar('PREVISÃO DE ENTREGA:', '{previsao_entrega}, observado o prazo de tolerância de {prazo_tolerancia_dias} dias corridos, contados dessa data, usualmente admitido pela jurisprudência para obras em construção.'),
      labelPar('OBSERVAÇÕES GERAIS DA VENDA:', '{observacoes_gerais_venda}'),
      par('O(A) PROPONENTE acima qualificado(a) apresenta, por intermédio de {imobiliaria_nome}, CRECI {imobiliaria_creci}, através do(a) corretor(a) {corretor_nome} (CRECI {corretor_creci}), a presente proposta de compra da unidade acima descrita, nos termos seguintes:', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do valor da proposta', 'O valor proposto para a compra é de R$ {valor_proposta} ({valor_proposta_extenso}).'),
      clausula(2, 'do sinal de negócio', 'Junto com esta proposta, o(a) PROPONENTE entrega, a título de sinal de negócio e princípio de pagamento, o valor de R$ {valor_sinal} ({percentual_sinal}% do valor da proposta), que ficará sob a administração de {imobiliaria_nome} até a manifestação da INCORPORADORA/CONSTRUTORA.'),
      clausula(3, 'da forma de pagamento', '{forma_pagamento_proposta}'),
      clausula(4, 'da correção monetária do saldo', 'Enquanto pendente a conclusão da obra, o saldo devedor será corrigido pelo índice {indice_correcao_saldo_obra}. Após a expedição do habite-se e/ou entrega das chaves, a correção do saldo remanescente passará a ser feita pelo índice {indice_correcao_saldo_pos_entrega}.'),
      clausula(5, 'da documentação', 'A documentação relativa à transferência da unidade será paga por: {responsavel_documentacao}.'),
      clausula(6, 'do prazo de aceite', 'A presente proposta vincula o(a) PROPONENTE pelo prazo de {prazo_aceite_dias} dias corridos, contados desta data, findo o qual, na ausência de manifestação expressa da INCORPORADORA/CONSTRUTORA, poderá ser considerada sem efeito, com devolução integral do sinal.'),
      clausula(7, 'das arras', 'O presente negócio é realizado de acordo com o art. 420 do Código Civil, sendo que o sinal de negócio faz parte dos honorários da imobiliária pela sua intermediação. Havendo arrependimento por parte do(a) PROPONENTE, este(a) perderá o sinal de negócio em favor da INCORPORADORA/CONSTRUTORA; havendo arrependimento por parte da INCORPORADORA/CONSTRUTORA, esta deverá devolver ao(à) PROPONENTE o valor do sinal ora recebido, mais o seu equivalente.'),
      subitem('Parágrafo primeiro: o valor pago como sinal de negócio e princípio de pagamento fará parte do pagamento do preço estipulado, aplicando-se o disposto nos arts. 418 e 419 do Código Civil.'),
      subitem('Parágrafo segundo: caso seja utilizado cheque referente ao sinal de negócio, este terá caráter pró-solvendo, dando-se por quitado somente após compensação bancária.'),
      clausula(8, 'do atraso na entrega da obra', 'Observado o prazo de tolerância indicado no quadro-resumo, eventual atraso na entrega que o exceda assegurará ao(à) PROPONENTE os direitos e garantias previstos na legislação consumerista e na Lei nº 4.591/64, sem prejuízo de indenização por perdas e danos porventura cabível, na forma da lei.'),
      clausula(9, 'dos esclarecimentos sobre o empreendimento', 'O(A) PROPONENTE declara que recebeu todos os esclarecimentos do Corretor de Imóveis referentes ao empreendimento, ao estágio da obra, ao memorial de incorporação e a eventuais ônus incidentes, conforme prevê o art. 723 e parágrafo único do Código Civil.'),
      clausula(10, 'da proteção de dados', 'As partes autorizam o tratamento dos dados pessoais constantes deste documento pela imobiliária interveniente, exclusivamente para as finalidades relacionadas a esta proposta, nos termos da Lei nº 13.709/2018 (LGPD).'),
      clausula(11, 'do foro', 'Fica eleito o foro da comarca de {cidade_contrato} para dirimir quaisquer dúvidas oriundas deste documento.'),
      par('E, por estarem assim justos, firmam a presente proposta em vias de igual teor e forma, na presença das testemunhas abaixo.', { margin: [0, 14, 0, 0] }),
      assinaturas(['PROPONENTE — {proponente_nome}', 'INCORPORADORA/CONSTRUTORA — {construtora_razao_social}', 'IMOBILIÁRIA INTERVENIENTE — {imobiliaria_nome}']),
      testemunhas(),
      disclaimer(),
    ],

    // 4. TERMO DE ENTREGA/RETIRADA DE CHAVES (modelo próprio Gregório | Meu Lar)
    retirada_chaves: [
      titulo('TERMO DE ENTREGA DE CHAVES DO IMÓVEL'),
      identificacao(),
      labelPar('RECEBEDOR(A):', '{recebedor_nome}, {recebedor_nacionalidade}, {recebedor_estado_civil}, {recebedor_profissao}, portador(a) do RG nº {recebedor_rg} e CPF nº {recebedor_cpf}, endereço {recebedor_endereco}, telefone {recebedor_telefone}, e-mail {recebedor_email}.'),
      labelPar('IMÓVEL:', 'imóvel do tipo {imovel_tipo}, com {imovel_area_construida} m², {imovel_comodos_descricao}, localizado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}. {imovel_matriculas_concessionarias}'),
      par('RETIRAMOS AS CHAVES do imóvel acima identificado, em {data_hora_retirada}, para fins de {finalidade_retirada}, na modalidade: {tipo_retirada}, entregues por {responsavel_entrega}, em nome de {imobiliaria_nome}, CRECI {imobiliaria_creci}.', { margin: [0, 10, 0, 14] }),
      clausula(1, 'da declaração de conformidade', 'O(A) RECEBEDOR(A) declara, para todos os fins que se fizerem necessários, que o imóvel ora recebido está de acordo com a respectiva proposta/contrato e com o Laudo de Vistoria de Entrada, estando ciente de que, a partir desta data, correrão por sua conta todas as despesas referentes ao imóvel, tais como luz, internet, gás, IPTU e quaisquer outras manutenções.'),
      clausula(2, 'do prazo de devolução', '{#retirada_temporaria}O(A) RECEBEDOR(A) compromete-se a devolver a(s) chave(s) até {data_prevista_devolucao}, no mesmo estado em que as recebeu, sob pena de responder pelas medidas cabíveis em caso de atraso, dano ou extravio.{/retirada_temporaria}{^retirada_temporaria}A retirada das chaves nesta data marca a entrega da posse do imóvel ao(à) RECEBEDOR(A), nos termos do contrato firmado entre as partes.{/retirada_temporaria}'),
      clausula(3, 'da responsabilidade', 'O(A) RECEBEDOR(A) é responsável pela guarda da(s) chave(s) enquanto estiver(em) em seu poder, respondendo por danos decorrentes de mau uso, extravio, cópia não autorizada ou empréstimo a terceiros sem anuência de {imobiliaria_nome}.'),
      clausula(4, 'do estado do imóvel', 'No ato desta retirada, o imóvel foi encontrado nas seguintes condições: {estado_imovel_retirada}.'),
      clausula(5, 'das observações', '{observacoes_retirada}'),
      par('E, por estarem de acordo, firmam o presente termo.', { margin: [0, 14, 0, 0] }),
      assinaturas(['{recebedor_nome}', 'ENTREGUE POR — {responsavel_entrega} ({imobiliaria_nome})']),
      disclaimer(),
    ],

    // 5. FICHA DE VISITA COM SINAL DE RESERVA
    ficha_visita_reserva: [
      titulo('FICHA DE VISITA COM SINAL DE RESERVA'),
      identificacao(),
      labelPar('VISITANTE:', '{visitante_nome}, {visitante_nacionalidade}, {visitante_estado_civil}, {visitante_profissao}, portador(a) do RG nº {visitante_rg} e CPF nº {visitante_cpf}, telefone {visitante_telefone}, e-mail {visitante_email}, residente em {visitante_endereco}.'),
      labelPar('IMÓVEL VISITADO:', 'imóvel do tipo {imovel_tipo}, situado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}.'),
      labelPar('DATA/HORA DA VISITA:', '{data_hora_visita}    Corretor(a): {corretor_nome} (CRECI {corretor_creci})'),
      labelPar('INTERESSE:', '{interesse_visita}'),
      par('Após a visita ao imóvel acima identificado, o(a) VISITANTE manifesta interesse em {interesse_visita} e, para reservar o imóvel enquanto formaliza o negócio, entrega a {imobiliaria_nome} o valor de R$ {valor_sinal_reserva} ({valor_sinal_reserva_extenso}) a título de sinal de reserva, nas condições abaixo:', { margin: [0, 10, 0, 14] }),
      clausula(1, 'da reserva', 'Mediante o pagamento acima, o imóvel ficará reservado exclusivamente para o(a) VISITANTE, sem novas visitas ou propostas de terceiros, pelo prazo de {prazo_reserva_dias} dias corridos a contar desta data.'),
      clausula(2, 'da destinação do sinal', 'Caso o negócio se concretize dentro do prazo de reserva, o valor será integralmente abatido do preço total; caso o(a) VISITANTE desista do negócio dentro do prazo, o valor poderá ser retido a título de indenização pela reserva; caso o negócio não se concretize por indisponibilidade do imóvel ou desistência do(a) proprietário(a), o valor será devolvido integralmente.'),
      clausula(3, 'do encerramento', 'Findo o prazo de reserva sem a formalização de proposta e/ou contrato, a reserva perde automaticamente a validade, podendo o imóvel voltar à divulgação, salvo prorrogação combinada por escrito entre as partes.'),
      clausula(4, 'das observações', '{observacoes_visita}'),
      assinaturas(['{visitante_nome}', 'IMOBILIÁRIA — {imobiliaria_nome}']),
      disclaimer(),
    ],

    // 6. CONTRATO DE INTERMEDIAÇÃO E AUTORIZAÇÃO VENDA EXCLUSIVIDADE (modelo próprio Gregório | Meu Lar)
    termo_autorizacao: [
      titulo('CONTRATO DE INTERMEDIAÇÃO E AUTORIZAÇÃO VENDA EXCLUSIVIDADE'),
      identificacao(),
      labelPar('CONTRATANTE 1 (proprietário(a)):', '{proprietario_nome}, {proprietario_nacionalidade}, {proprietario_estado_civil}, {proprietario_profissao}, portador(a) do RG nº {proprietario_rg} e CPF/CNPJ nº {proprietario_cpf}, residente e domiciliado(a) em {proprietario_endereco}, e-mail {proprietario_email}, telefone/WhatsApp {proprietario_telefone}.'),
      par('{#tem_proprietario2}CONTRATANTE 2 (proprietário(a)): {proprietario2_nome}, {proprietario2_nacionalidade}, {proprietario2_estado_civil}, {proprietario2_profissao}, portador(a) do RG nº {proprietario2_rg} e CPF/CNPJ nº {proprietario2_cpf}, residente e domiciliado(a) em {proprietario2_endereco}, e-mail {proprietario2_email}, telefone/WhatsApp {proprietario2_telefone}.{/tem_proprietario2}'),
      labelPar('CORRETOR(A) DE IMÓVEIS:', '{imobiliaria_nome}, CNPJ {imobiliaria_cnpj}, CRECI {imobiliaria_creci}, com sede em {imobiliaria_endereco_completo}, representada por {corretor_nome}, CRECI {corretor_creci}, e-mail {imobiliaria_email}, telefone/WhatsApp {imobiliaria_telefone}.'),
      labelPar('IMÓVEL(ÉIS) OBJETO DO CONTRATO:', '{imovel_tipo}, {imovel_descricao_detalhada}, localizado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}.'),
      labelPar('FINALIDADE DO CONTRATO:', 'Venda.'),
      labelPar('EXCLUSIVIDADE:', 'Sim, com exclusividade.'),
      labelPar('PRAZO DE VIGÊNCIA:', 'Início: {data_inicio_autorizacao}   Término: {data_termino_autorizacao}   Renovação automática: {renovacao_automatica}.'),
      labelPar('TIPOS DE PUBLICIDADE PERMITIDA:', '{tipos_publicidade_permitida}'),
      labelPar('DOCUMENTOS APRESENTADOS PELO(A) CONTRATANTE:', '{documentos_apresentados}'),
      clausula(1, 'das partes e do objeto do contrato', 'Considerando os dados constantes do quadro-resumo acima, as partes nele qualificadas firmam o presente Contrato de Intermediação Imobiliária com Exclusividade, com fundamento nos arts. 722 a 729 do Código Civil, na Lei nº 13.709/2018 (LGPD) e demais dispositivos legais aplicáveis, obrigando-se reciprocamente às cláusulas e condições abaixo pactuadas.'),
      subitem('1.1. O(A) CONTRATANTE declara ser legítimo(a) possuidor(a) e proprietário(a) do(s) imóvel(is) descrito(s) acima, os quais se encontram livres e desembaraçados de quaisquer ônus, gravames, dívidas ou restrições que impeçam ou comprometam sua comercialização, autorizando expressamente o(a) CORRETOR(A) a promover sua oferta ao mercado nas condições descritas neste instrumento.'),
      clausula(2, 'da finalidade contratual', 'O presente instrumento tem por objeto a prestação, pelo(a) CORRETOR(A), de serviços profissionais de intermediação imobiliária, com exclusividade, para fins de venda do(s) imóvel(is) indicado(s), conforme pactuado entre as partes.'),
      clausula(3, 'da prestação de serviços', 'O(A) CORRETOR(A) compromete-se a desempenhar suas atribuições com diligência, lealdade, ética, sigilo profissional, boa-fé e observância das práticas de mercado, arcando com os custos de publicidade e demais encargos operacionais inerentes à divulgação e à intermediação do imóvel, salvo ajuste em contrário.'),
      clausula(4, 'da possibilidade de substituição', 'O(A) CORRETOR(A) poderá, sob sua exclusiva responsabilidade, fazer-se substituir por outro profissional ou empresa habilitada, mantendo-se, entretanto, como único(a) responsável perante o(a) CONTRATANTE por todas as obrigações decorrentes deste instrumento.'),
      clausula(5, 'dos honorários de corretagem', 'Os honorários de corretagem serão devidos ao(à) CORRETOR(A) pela efetiva aproximação das partes e celebração do negócio jurídico, nos termos do art. 725 do Código Civil, mesmo que por interposta pessoa, ainda que o negócio se concretize após a vigência deste contrato, desde que decorrente de sua atuação (art. 727, CC).'),
      subitem('5.2. A remuneração devida ao(à) CORRETOR(A) será paga no momento da assinatura do compromisso de compra e venda, do contrato de financiamento ou da escritura pública, o que ocorrer primeiro, preferencialmente de forma concomitante ao recebimento de quaisquer valores pela parte vendedora. O pagamento será feito exclusivamente por transferência eletrônica para a conta bancária informada pelo(a) CORRETOR(A).'),
      subitem('5.3. A comissão de {percentual_comissao_autorizacao}% será devida integralmente ao(à) CORRETOR(A) quando houver aceitação da proposta, recebimento de sinal ou início do cumprimento do contrato, ainda que o negócio não se consume por desistência unilateral, sendo devida pela parte que lhe deu causa.'),
      subitem('5.4. Por se tratar de intermediação com cláusula de exclusividade, a comissão será devida mesmo que o negócio seja concluído sem a participação do(a) CORRETOR(A), inclusive por iniciativa direta do(a) CONTRATANTE ou de terceiros, nos termos do art. 726 do Código Civil.'),
      subitem('5.5. O(A) CONTRATANTE responderá integralmente pelos honorários caso, por sua iniciativa, proponha condições distintas das originalmente estabelecidas, inviabilizando a concretização do negócio.'),
      subitem('5.6. O(A) CORRETOR(A) poderá, a seu critério, repartir os honorários entre co-corretores ou outros profissionais envolvidos na intermediação, sem que tal distribuição implique alteração no valor total pactuado com o(a) CONTRATANTE.'),
      clausula(6, 'das contraofertas', 'O(A) CORRETOR(A) fica autorizado(a) a receber propostas e contraofertas, sempre condicionadas à aprovação expressa e formal do(a) CONTRATANTE.'),
      clausula(7, 'da vigência e da exclusividade', 'O prazo de vigência do presente contrato observará o estipulado no quadro-resumo acima, durante o qual o(a) CONTRATANTE não poderá oferecer o imóvel a outra imobiliária ou corretor(a), nem realizar a venda por conta própria, sem incorrer no pagamento da comissão prevista na CLÁUSULA QUINTA.'),
      subitem('7.2. Eventuais negociações iniciadas durante a vigência contratual somente poderão ter continuidade após seu encerramento mediante anuência expressa do(a) CONTRATANTE.'),
      clausula(8, 'disposições gerais', 'Ao término do contrato, todos os documentos confiados ao(à) CORRETOR(A) serão restituídos ao(à) CONTRATANTE.'),
      subitem('8.2. Eventuais vícios ocultos ou redibitórios do(s) imóvel(eis) serão de responsabilidade exclusiva do(a) CONTRATANTE, conforme arts. 441 a 446 do Código Civil.'),
      subitem('8.3. O(A) CONTRATANTE responderá por quaisquer ônus fiscais, legais ou judiciais que recaiam sobre o imóvel, inclusive certidões, taxas ou tributos exigíveis para a realização da transação.'),
      subitem('8.4. Este instrumento substitui e prevalece sobre quaisquer entendimentos, ajustes ou contratos anteriores relativos ao mesmo objeto.'),
      subitem('8.5. Os dados pessoais fornecidos serão tratados conforme a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018), respeitando-se sua confidencialidade e segurança.'),
      subitem('8.6. O(A) CONTRATANTE declara estar em plena capacidade civil, não estando sujeito(a) a coação, dolo, estado de necessidade ou qualquer outro vício de consentimento.'),
      subitem('8.7. As partes se comprometem a resolver extrajudicialmente eventuais divergências oriundas deste contrato, priorizando a negociação direta e a boa-fé.'),
      subitem('8.8. Este contrato poderá ser formalizado e assinado por meio físico ou eletrônico, incluindo assinaturas digitais com certificação.'),
      subitem('8.9. Todas as comunicações entre as partes poderão ser realizadas por meio eletrônico, nos endereços constantes no quadro-resumo.'),
      subitem('8.10. O(A) CONTRATANTE declara estar ciente de que eventuais dúvidas sobre lucro imobiliário (ganho de capital) deverão ser sanadas com contador de sua confiança, regularmente inscrito no CRC, sendo sua responsabilidade o recolhimento de tributos decorrentes da venda.'),
      subitem('8.11. As obrigações previstas neste contrato vinculam o(a) CONTRATANTE e seus herdeiros ou sucessores.'),
      subitem('8.12. Quaisquer alterações a este contrato somente serão válidas se pactuadas por escrito e assinadas pelas partes.'),
      subitem('8.13. Em caso de rescisão, arrependimento ou uso indevido de material promocional, os custos de publicidade correrão exclusivamente por conta do(a) CONTRATANTE.'),
      clausula(9, 'do foro', 'As partes elegem o foro da comarca de {cidade_contrato} como o competente para dirimir quaisquer controvérsias oriundas deste instrumento, renunciando a qualquer outro, por mais privilegiado que seja.'),
      par('Por estarem justas e contratadas, firmam o presente instrumento por meio de assinatura física ou eletrônica qualificada/avançada, nos termos da legislação vigente.', { margin: [0, 14, 0, 0] }),
      assinaturas(['CONTRATANTE — {proprietario_nome}', '{#tem_proprietario2}CONTRATANTE — {proprietario2_nome}{/tem_proprietario2}', 'CONTRATADA — {imobiliaria_nome} ({corretor_nome})']),
      testemunhas(),
      disclaimer(),
    ],

    // 6B. AUTORIZAÇÃO DE ANÚNCIO SEM EXCLUSIVIDADE (NOVO)
    autorizacao_sem_exclusividade: [
      titulo('AUTORIZAÇÃO DE ANÚNCIO SEM EXCLUSIVIDADE'),
      identificacao(),
      labelPar('PROPRIETÁRIO(A)/CONSTRUTOR(A) 1:', '{proprietario_nome}, {proprietario_nacionalidade}, {proprietario_estado_civil}, {proprietario_profissao}, portador(a) do RG nº {proprietario_rg} e CPF/CNPJ nº {proprietario_cpf}, residente e domiciliado(a) em {proprietario_endereco}, e-mail {proprietario_email}, telefone/WhatsApp {proprietario_telefone}.'),
      par('{#tem_proprietario2}PROPRIETÁRIO(A) 2: {proprietario2_nome}, {proprietario2_nacionalidade}, {proprietario2_estado_civil}, {proprietario2_profissao}, portador(a) do RG nº {proprietario2_rg} e CPF/CNPJ nº {proprietario2_cpf}, residente e domiciliado(a) em {proprietario2_endereco}, e-mail {proprietario2_email}, telefone/WhatsApp {proprietario2_telefone}.{/tem_proprietario2}'),
      labelPar('IMÓVEL(ÉIS):', '{^multiplos_imoveis_bool}{imovel_tipo}, {imovel_descricao_detalhada}, localizado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}.{/multiplos_imoveis_bool}{#multiplos_imoveis_bool}Múltiplos imóveis de propriedade do(a) CONTRATANTE (construtor(a)/incorporador(a)), conforme relação detalhada no Anexo I deste instrumento.{/multiplos_imoveis_bool}'),
      par('{#multiplos_imoveis_bool}ANEXO I — RELAÇÃO DE IMÓVEIS OBJETO DESTE CONTRATO:\n{imoveis_lista_detalhada}{/multiplos_imoveis_bool}', { margin: [0, 4, 0, 10] }),
      labelPar('FINALIDADE:', '{finalidade_anuncio}.'),
      labelPar('VALOR PRETENDIDO:', '{^multiplos_imoveis_bool}R$ {valor_pretendido} ({valor_pretendido_extenso}).{/multiplos_imoveis_bool}{#multiplos_imoveis_bool}Conforme valor individual de cada unidade, indicado no Anexo I.{/multiplos_imoveis_bool}'),
      labelPar('PRAZO DE VIGÊNCIA:', 'Início: {data_inicio_anuncio}   Término: {data_termino_anuncio}.'),
      par('Pelo presente instrumento, o(a) PROPRIETÁRIO(A) acima qualificado(a) autoriza {imobiliaria_nome}, CRECI {imobiliaria_creci}, por meio do(a) corretor(a) {corretor_nome} (CRECI {corretor_creci}), a anunciar e intermediar, SEM EXCLUSIVIDADE, o(s) imóvel(is) acima descrito(s), nas condições a seguir.', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do objeto e da não exclusividade', 'A presente autorização é concedida em caráter NÃO EXCLUSIVO, podendo o(a) PROPRIETÁRIO(A) anunciar, autorizar e negociar o(s) mesmo(s) imóvel(is) simultaneamente com outras imobiliárias, corretores(as) autônomos(as) ou diretamente com interessados, sem qualquer restrição ou preferência em favor de {imobiliaria_nome}. {#multiplos_imoveis_bool}Cada unidade listada no Anexo I é considerada, para todos os fins, objeto autônomo desta autorização, podendo ser vendida, retirada da lista ou substituída mediante simples comunicação por escrito entre as partes, sem necessidade de aditivo formal.{/multiplos_imoveis_bool}'),
      clausula(2, 'da comissão de corretagem', 'A comissão de corretagem de {percentual_comissao_anuncio}% sobre o valor efetivo de cada negócio será devida a {imobiliaria_nome} exclusivamente quando o negócio for concretizado por sua efetiva intermediação — ou seja, quando o(a) comprador(a) ou locatário(a) tiver sido apresentado(a), atendido(a) ou aproximado(a) por {imobiliaria_nome}, nos termos do art. 725 do Código Civil.'),
      subitem('Parágrafo único: caso o negócio se concretize por intermediação de outra imobiliária, corretor(a) ou diretamente entre o(a) PROPRIETÁRIO(A) e o(a) interessado(a), sem qualquer participação de {imobiliaria_nome}, nenhuma comissão será devida a esta.'),
      clausula(3, 'das obrigações da imobiliária', '{imobiliaria_nome} se compromete a anunciar o(s) imóvel(is) nos canais que julgar adequados, realizar visitas acompanhadas, prestar informações periódicas ao(à) PROPRIETÁRIO(A) e submeter todas as propostas recebidas para sua análise e aprovação.'),
      clausula(4, 'da publicidade', 'Fica autorizada a divulgação do(s) imóvel(is) por meio de {tipos_publicidade_permitida_anuncio}.'),
      clausula(5, 'da vigência e revogação', 'A presente autorização vigora pelo prazo indicado no quadro acima, podendo ser revogada a qualquer momento por qualquer das partes, mediante simples comunicação por escrito, sem prejuízo de comissão eventualmente já devida por negócio em andamento decorrente da atuação de {imobiliaria_nome}.'),
      clausula(6, 'da proteção de dados', 'O(A) PROPRIETÁRIO(A) autoriza o tratamento dos dados pessoais e do(s) imóvel(is) aqui descritos para as finalidades de divulgação e intermediação do(s) negócio(s), nos termos da Lei nº 13.709/2018 (LGPD).'),
      clausula(7, 'do foro', 'Fica eleito o foro da comarca de {cidade_contrato} para dirimir quaisquer dúvidas oriundas deste termo.'),
      par('E, por estarem de acordo, firmam o presente instrumento.', { margin: [0, 14, 0, 0] }),
      assinaturas(['PROPRIETÁRIO(A) — {proprietario_nome}', '{#tem_proprietario2}PROPRIETÁRIO(A) — {proprietario2_nome}{/tem_proprietario2}', 'IMOBILIÁRIA — {imobiliaria_nome} ({corretor_nome})']),
      disclaimer(),
    ],

    // 7. RECIBO DE SINAL / RESERVA
    recibo: [
      titulo('RECIBO DE SINAL / RESERVA'),
      identificacao(),
      runsPar([
        { text: 'Recebi de ' }, { text: '{pagador_nome}', bold: true }, { text: ', portador(a) do CPF nº ' }, { text: '{pagador_cpf}', bold: true },
        { text: ', a importância de ' }, { text: 'R$ {valor_recebido}', bold: true }, { text: ' (' }, { text: '{valor_recebido_extenso}' }, { text: '), referente a ' }, { text: '{finalidade_recibo}' },
        { text: ' relativo(a) ao imóvel situado em ' }, { text: '{imovel_endereco_completo}' }, { text: ', matrícula nº ' }, { text: '{imovel_matricula}' }, { text: '.' },
      ], { margin: [0, 14, 0, 12] }),
      par('{condicao_recibo}', { margin: [0, 0, 0, 12] }),
      par('Para maior clareza e cumprimento de seus efeitos, firmo o presente recibo em 2 (duas) vias de igual teor.', { margin: [0, 0, 0, 4] }),
      assinaturas(['{recebedor_nome}', 'IMOBILIÁRIA — {imobiliaria_nome}']),
      disclaimer(),
    ],

    // 8. CONTRATO DE PARCERIA ENTRE IMOBILIÁRIAS
    parceria: [
      titulo('{titulo_parceria}'),
      identificacao(),
      labelPar('{parceiro_label}:', '{parceiro_qualificacao}'),
      par('{imobiliaria_nome} e {parceiro_ref}, acima qualificados(as), resolvem firmar o presente Contrato de Parceria, mediante as cláusulas seguintes:', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do objeto', '{imobiliaria_nome} e {parceiro_ref} firmam parceria para intermediação conjunta de negócios imobiliários (venda e/ou locação), compartilhando carteiras de imóveis e/ou clientes conforme oportunidades específicas acordadas entre as partes.'),
      clausula(2, 'da divisão de comissão', 'Nos negócios realizados em parceria, a comissão de corretagem será dividida na proporção de {percentual_imobiliaria1}% para {imobiliaria_nome} e {percentual_parceira}% para {parceiro_ref}, salvo acordo diverso registrado por escrito para negócio específico.'),
      clausula(3, 'da autoria e prioridade', 'Em caso de dúvida sobre quem captou primeiro o cliente ou o imóvel, prevalecerá o registro mais antigo em sistema (CRM/agenda) ou a comprovação documental correspondente (mensagens, e-mails, fichas de visita).'),
      clausula(4, 'da confidencialidade', 'As partes comprometem-se a não repassar a terceiros dados de clientes, proprietários e imóveis obtidos em razão desta parceria, sem autorização expressa da parte que os originou.'),
      clausula(5, 'do prazo e rescisão', 'Este contrato vigora por prazo indeterminado, podendo ser rescindido por qualquer das partes mediante aviso prévio de {prazo_aviso_previo_dias} dias, sem prejuízo da conclusão dos negócios já em andamento na data da rescisão.'),
      clausula(6, 'da independência entre as partes', 'Cada parte permanece integralmente responsável por suas próprias obrigações legais, fiscais, trabalhistas e regulatórias (CRECI, tributos etc.), não havendo qualquer vínculo societário, trabalhista ou de representação entre as partes além do previsto neste contrato.'),
      clausula(7, 'do foro', 'Fica eleito o foro da Comarca de {cidade_contrato} para dirimir quaisquer dúvidas oriundas deste contrato.'),
      par('E, por estarem assim justas e contratadas, firmam o presente instrumento em 2 (duas) vias de igual teor e forma, na presença das testemunhas abaixo.', { margin: [0, 14, 0, 0] }),
      assinaturas(['{imobiliaria_nome}', '{parceiro_label} — {parceiro_nome}']),
      testemunhas(),
      disclaimer(),
    ],

    // 9. CONTRATO DE INTERMEDIAÇÃO DE LOCAÇÃO
    intermediacao_locacao: [
      titulo('CONTRATO DE INTERMEDIAÇÃO DE LOCAÇÃO'),
      identificacao(),
      labelPar('PROPRIETÁRIO(A):', '{proprietario_nome}, {proprietario_nacionalidade}, {proprietario_estado_civil}, {proprietario_profissao}, portador(a) do RG nº {proprietario_rg} e CPF nº {proprietario_cpf}, residente e domiciliado(a) em {proprietario_endereco}.'),
      labelPar('IMÓVEL:', 'imóvel do tipo {imovel_tipo}, situado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}.'),
      par('O(A) PROPRIETÁRIO(A) acima qualificado(a) contrata {imobiliaria_nome}, CRECI {imobiliaria_creci}, para intermediar e administrar a locação do imóvel acima descrito, nos termos seguintes:', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do objeto', 'A intermediação e administração compreende a divulgação do imóvel, seleção e aprovação de candidatos a locatário, elaboração do contrato de locação, cobrança mensal do aluguel e encargos, e repasse dos valores ao(à) PROPRIETÁRIO(A).'),
      clausula(2, 'da taxa de administração', 'Pelos serviços prestados, {imobiliaria_nome} fará jus a uma taxa de administração de {taxa_administracao_percentual}% sobre o valor do aluguel recebido mensalmente, deduzida diretamente no repasse.'),
      clausula(3, 'do repasse', 'Os valores recebidos do(a) locatário(a) serão repassados ao(à) PROPRIETÁRIO(A) até o dia {dia_repasse} de cada mês, mediante {forma_repasse}, descontadas a taxa de administração e eventuais despesas previamente acordadas.'),
      clausula(4, 'do prazo', 'Este contrato vigora pelo prazo de {prazo_contrato_meses} meses, renovando-se automaticamente por igual período caso não haja manifestação em contrário, podendo ser rescindido por qualquer das partes mediante aviso prévio de {prazo_aviso_rescisao_dias} dias.'),
      clausula(5, 'das obrigações do(a) proprietário(a)', 'Manter o imóvel em condições adequadas de uso e habitação, fornecer a documentação necessária para a locação e comunicar {imobiliaria_nome} sobre quaisquer alterações relevantes. {obrigacoes_proprietario}'),
      clausula(6, 'da prestação de contas', '{imobiliaria_nome} prestará contas mensalmente ao(à) PROPRIETÁRIO(A), discriminando os valores recebidos, a taxa de administração e eventuais despesas.'),
      clausula(7, 'da proteção de dados', 'O(A) PROPRIETÁRIO(A) autoriza o tratamento dos dados pessoais e do imóvel aqui descritos para as finalidades relacionadas à administração da locação, nos termos da Lei nº 13.709/2018 (LGPD).'),
      clausula(8, 'do foro', 'Fica eleito o foro da Comarca de {cidade_contrato} para dirimir quaisquer dúvidas oriundas deste contrato.'),
      par('E, por estarem assim justos e contratados, firmam o presente instrumento em 2 (duas) vias de igual teor e forma, na presença das testemunhas abaixo.', { margin: [0, 14, 0, 0] }),
      assinaturas(['PROPRIETÁRIO(A)', '{imobiliaria_nome}']),
      testemunhas(),
      disclaimer(),
    ],

    // 10. NOTIFICAÇÃO DE DIREITO DE PREFERÊNCIA COM AVISO DE DESOCUPAÇÃO (NOVO)
    direito_preferencia: [
      titulo('NOTIFICAÇÃO DE DIREITO DE PREFERÊNCIA COM AVISO DE DESOCUPAÇÃO'),
      identificacao(),
      labelPar('AO(À) SR(A):', '{locatario_nome}, CPF {locatario_cpf}.'),
      par('Na condição de administradora do imóvel do qual V.Sa. é locatário(a), e observando o disposto no art. 27 da Lei nº 8.245/91, vimos, pelo presente, oferecer o referido imóvel: {imovel_tipo}, {imovel_descricao_detalhada}, situado em {imovel_endereco_completo}, pelo valor de R$ {valor_venda} ({valor_venda_extenso}).', { margin: [0, 10, 0, 12] }),
      par('A contar do recebimento desta notificação, V.Sa. poderá manifestar-se, sinalizando neste documento o interesse em comprar o imóvel, ou sinalizar que não tem interesse na compra. Fica registrado que, na data de início da locação, V.Sa. já estava ciente de que o imóvel se encontrava anunciado à venda. Havendo interesse na compra, V.Sa. deverá assinar a respectiva proposta, com pagamento à vista, para quitação em até {prazo_pagamento_avista_dias} dias.', { margin: [0, 0, 0, 12] }),
      par('Caso opte por não comprar o imóvel, V.Sa. terá o prazo de {prazo_desocupacao_dias} dias para desocupação do imóvel, a partir da data de recebimento deste documento. O prazo para manifestação quanto a este documento é de {prazo_manifestacao_horas} horas; não havendo manifestação dentro deste prazo, será considerado o desinteresse na compra do imóvel.', { margin: [0, 0, 0, 16] }),
      par('_______________________________________________', { margin: [0, 6, 0, 2] }),
      par('LOCATÁRIO(A): NÃO vou comprar o imóvel. Assinatura: _______________________', { margin: [0, 0, 0, 16] }),
      par('_______________________________________________', { margin: [0, 6, 0, 2] }),
      par('LOCATÁRIO(A): SIM, vou comprar o imóvel. Assinatura: _______________________', { margin: [0, 0, 0, 8] }),
      par('{observacoes_direito_preferencia}', { margin: [0, 0, 0, 8] }),
      assinaturas(['ADMINISTRADORA — {imobiliaria_nome}']),
      disclaimer(),
    ],

    // 11. DISTRATO CONSENSUAL DE CONTRATO DE LOCAÇÃO (NOVO)
    distrato_locacao: [
      titulo('INSTRUMENTO PARTICULAR DE DISTRATO CONSENSUAL DE CONTRATO DE LOCAÇÃO'),
      identificacao(),
      labelPar('LOCADOR(A):', '{locador_nome}, {locador_nacionalidade}, {locador_estado_civil}, CPF/CNPJ nº {locador_cpf}, com endereço em {locador_endereco}, neste ato representado(a) por sua ADMINISTRADORA {imobiliaria_nome}, CNPJ {imobiliaria_cnpj}, CRECI {imobiliaria_creci}, doravante denominada simplesmente ADMINISTRADORA.'),
      labelPar('LOCATÁRIO(A):', '{locatario_nome}, CPF/CNPJ {locatario_cpf}, {locatario_responsavel_legal}, com endereço em {locatario_endereco}.'),
      par('Têm entre si, justo e acordado, o presente Distrato Consensual de Contrato de Locação, o qual se regerá pelas disposições da Lei nº 8.245/91 (Lei do Inquilinato) e pelas cláusulas e condições abaixo:', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do objeto', 'As partes resolvem rescindir, de comum acordo, o Contrato de Locação firmado em {data_contrato_original}, referente ao imóvel situado em {imovel_endereco_completo}, extinguindo-se a relação locatícia mediante as condições estabelecidas neste instrumento.'),
      clausula(2, 'da rescisão antecipada', 'A rescisão ocorre por iniciativa {iniciativa_rescisao}, sendo fixada a data de {data_termo_rescisao} como termo da rescisão contratual, {aplicacao_multa}.'),
      subitem('Parágrafo único: as partes reconhecem que a rescisão decorre de livre manifestação de vontade, inexistindo vício de consentimento.'),
      clausula(3, 'da desocupação do imóvel', 'O(A) LOCATÁRIO(A) entregará o imóvel livre e desocupado de pessoas e bens, juntamente com todas as chaves, controles remotos, cartões de acesso, senhas e demais dispositivos disponibilizados durante a locação, comprometendo-se a desocupar voluntariamente o imóvel até, impreterivelmente, {prazo_desocupacao_data}, entregando-o nas mesmas condições em que o recebeu, salvo as deteriorações decorrentes do uso normal, conforme o art. 23, III, da Lei nº 8.245/91.'),
      subitem('Parágrafo único: caso sejam constatados danos além do desgaste natural, o LOCADOR poderá exigir o respectivo ressarcimento.'),
      clausula(4, 'da devolução do depósito caução', 'A caução prestada no início da locação {situacao_caucao}, conforme previsão contratual.'),
      subitem('Parágrafo único: as partes reconhecem expressamente que a destinação da caução ocorre de forma consensual, nada tendo o(a) LOCATÁRIO(A) a reclamar quanto ao depósito caução.'),
      clausula(5, 'da quitação', 'Após o cumprimento integral das obrigações previstas neste instrumento, as partes conferem entre si plena, geral, irrevogável e irretratável quitação relativamente ao contrato de locação rescindido, nada mais podendo reclamar uma da outra, seja a que título for, ressalvadas apenas as obrigações previstas neste distrato e eventuais danos ocultos constatados após a entrega do imóvel.'),
      clausula(6, 'das despesas', 'O(A) LOCATÁRIO(A) declara que permanecerá responsável pelo pagamento de todos os aluguéis, encargos locatícios, água, energia elétrica, condomínio, IPTU e demais despesas incidentes até a efetiva entrega das chaves, comprometendo-se a apresentar os respectivos comprovantes quando solicitado.'),
      clausula(7, 'da vistoria', 'Será realizada vistoria final do imóvel no ato da entrega das chaves.'),
      subitem('Parágrafo único: caso sejam constatados danos não decorrentes do desgaste natural do uso, o(a) LOCATÁRIO(A) compromete-se a reparar os danos ou indenizar o LOCADOR pelos respectivos custos.'),
      clausula(8, 'da entrega das chaves', 'A entrega das chaves será formalizada mediante termo específico, ocasião em que cessará a responsabilidade do(a) LOCATÁRIO(A) pelo imóvel, ressalvadas as obrigações remanescentes previstas neste instrumento.'),
      clausula(9, 'disposição final', 'As partes declaram que celebram o presente distrato por livre manifestação de vontade, renunciando expressamente ao ajuizamento de qualquer demanda decorrente do contrato ora rescindido, ressalvado o descumprimento das obrigações previstas neste instrumento.'),
      par('{observacoes_distrato}', { margin: [0, 8, 0, 0] }),
      par('E, por estarem assim justas e contratadas, firmam o presente instrumento.', { margin: [0, 14, 0, 0] }),
      assinaturas(['PELA ADMINISTRADORA — {imobiliaria_nome}', 'LOCATÁRIO(A) — {locatario_nome}']),
      disclaimer(),
    ],

    // 12. OFERTA DE IMÓVEL PARA CONSTRUTORA/INCORPORADORA (NOVO)
    oferta_construtor: [
      titulo('OFERTA DE IMÓVEL PARA CONSTRUTORA/INCORPORADORA'),
      identificacao(),
      labelPar('OFERTANTE:', '{proprietario_nome}, {proprietario_nacionalidade}, {proprietario_estado_civil}, {proprietario_profissao}, portador(a) do RG nº {proprietario_rg} e CPF/CNPJ nº {proprietario_cpf}, residente e domiciliado(a) em {proprietario_endereco}, e-mail {proprietario_email}, telefone/WhatsApp {proprietario_telefone}, neste ato representado(a) por {imobiliaria_nome}, CRECI {imobiliaria_creci}, por meio do(a) corretor(a) {corretor_nome} (CRECI {corretor_creci}).'),
      labelPar('DESTINATÁRIA:', '{construtora_razao_social}, CNPJ nº {construtora_cnpj}, com sede em {construtora_endereco}, neste ato representada por {construtora_representante_nome}, CPF nº {construtora_representante_cpf}.'),
      labelPar('IMÓVEL OFERTADO:', 'imóvel do tipo {imovel_tipo}, com {imovel_area_total} m² de área total, situado em {imovel_endereco_completo}, matrícula nº {imovel_matricula}. Potencial construtivo/zoneamento: {imovel_potencial_construtivo}. {imovel_descricao_detalhada}'),
      par('Pelo presente instrumento, o(a) OFERTANTE acima qualificado(a) apresenta à DESTINATÁRIA a presente OFERTA relativa ao imóvel descrito, para fins de avaliação e eventual negociação, nas condições a seguir.', { margin: [0, 10, 0, 14] }),
      clausula(1, 'do objeto', 'O(A) OFERTANTE, na qualidade de proprietário(a) do imóvel acima descrito, apresenta à DESTINATÁRIA a presente oferta para fins de avaliação e eventual negociação, nos termos e condições abaixo.'),
      clausula(2, 'da modalidade da oferta', '{#oferta_permuta}A presente oferta é realizada na modalidade de PERMUTA POR UNIDADES, mediante as seguintes condições: {condicoes_permuta}{/oferta_permuta}{#oferta_venda_direta}A presente oferta é realizada na modalidade de VENDA DIRETA, pelo valor de R$ {valor_venda_direta} ({valor_venda_direta_extenso}).{/oferta_venda_direta}{#oferta_parceria}A presente oferta é realizada na modalidade de PARCERIA/INCORPORAÇÃO, mediante as seguintes condições: {condicoes_parceria}{/oferta_parceria}'),
      clausula(3, 'da exclusividade', '{#tem_exclusividade_bool}O imóvel objeto desta oferta encontra-se sob EXCLUSIVIDADE de {imobiliaria_nome} (CRECI {imobiliaria_creci}), sendo devida a esta a comissão de corretagem de {percentual_comissao_oferta}% sobre o valor efetivo do negócio, caso este se concretize com a DESTINATÁRIA.{/tem_exclusividade_bool}{^tem_exclusividade_bool}O imóvel objeto desta oferta NÃO possui exclusividade em favor de {imobiliaria_nome}, podendo estar sendo oferecido simultaneamente por outros(as) corretores(as), outras imobiliárias ou diretamente pelo(a) proprietário(a). A comissão de corretagem, se devida, será apurada conforme a efetiva intermediação do negócio, nos termos do art. 725 do Código Civil.{/tem_exclusividade_bool}'),
      clausula(4, 'do prazo de validade', 'A presente oferta tem validade de {prazo_validade_oferta_dias} dias, contados da data de emissão deste documento, findo o qual poderá ser renovada, alterada ou retirada a critério do(a) OFERTANTE, sem necessidade de justificativa.'),
      clausula(5, 'da veracidade das informações', 'As informações constantes neste documento foram fornecidas pelo(a) OFERTANTE e/ou obtidas de fontes públicas, não se responsabilizando {imobiliaria_nome} por eventuais divergências que só possam ser apuradas mediante due diligence própria da DESTINATÁRIA.'),
      clausula(6, 'do foro', 'Fica eleito o foro da comarca de {cidade_contrato} para dirimir quaisquer dúvidas oriundas desta oferta.'),
      par('_______________________________________________', { margin: [0, 16, 0, 2] }),
      par('DESTINATÁRIA: ACEITA a oferta nos termos apresentados. Assinatura: _______________________', { margin: [0, 0, 0, 16] }),
      par('_______________________________________________', { margin: [0, 6, 0, 2] }),
      par('DESTINATÁRIA: apresenta CONTRAPROPOSTA (descrever): _____________________________________________', { margin: [0, 0, 0, 8] }),
      par('{observacoes_oferta}', { margin: [0, 0, 0, 8] }),
      assinaturas(['OFERTANTE — {proprietario_nome}', 'IMOBILIÁRIA — {imobiliaria_nome} ({corretor_nome})']),
      disclaimer(),
    ],

    // 13. PRESTAÇÃO DE CONTAS — REPASSE DE ALUGUEL (NOVO)
    prestacao_contas: [
      titulo('PRESTAÇÃO DE CONTAS — REPASSE DE ALUGUEL'),
      identificacao(),
      labelPar('PROPRIETÁRIO(A):', '{proprietario_nome}, CPF/CNPJ nº {proprietario_cpf}.'),
      labelPar('IMÓVEL:', '{imovel_tipo} situado em {imovel_endereco_completo}{#imovel_matricula}, matrícula nº {imovel_matricula}{/imovel_matricula}.'),
      labelPar('COMPETÊNCIA:', '{competencia_referencia} — repasse em {data_repasse}, via {forma_repasse}.'),
      par('A ADMINISTRADORA presta contas ao(à) PROPRIETÁRIO(A) acima qualificado(a) quanto ao aluguel recebido no período de referência, discriminando abaixo os descontos aplicados sobre o repasse — inclusive quando parcelados, com indicação da respectiva parcela — e demais lançamentos do período.', { margin: [0, 10, 0, 12] }),
      clausula(1, 'do valor bruto recebido', 'O valor bruto do aluguel recebido no período de referência é de R$ {valor_aluguel_bruto}, sobre o qual incide a taxa de administração de {taxa_administracao_percentual}%, equivalente a R$ {valor_taxa_administracao_fmt}.'),
      tabela('DESCONTOS APLICADOS NO REPASSE', 'descontos_repasse_lista', ['Descrição', 'Valor (R$)', 'Parcela']),
      par('Total de descontos no período: R$ {total_descontos_fmt}.', { margin: [0, 0, 0, 4] }),
      tabela('OUTROS LANÇAMENTOS / GASTOS DO PERÍODO', 'outros_gastos_lista', ['Descrição', 'Valor (R$)']),
      par('Total de outros lançamentos: R$ {total_outros_gastos_fmt}.', { margin: [0, 0, 0, 4] }),
      clausula(2, 'do valor líquido repassado', 'Após a dedução da taxa de administração, dos descontos e dos demais lançamentos discriminados acima, o valor líquido repassado ao(à) PROPRIETÁRIO(A) nesta competência é de R$ {valor_liquido_repassado_fmt}.'),
      clausula(3, 'da conferência', 'Esta prestação de contas fica sujeita à conferência pelo(a) PROPRIETÁRIO(A), que poderá solicitar esclarecimentos adicionais junto à ADMINISTRADORA no prazo de {prazo_contestacao_prestacao_dias} dias corridos, contados do recebimento deste documento.'),
      tabela('LANÇAMENTOS PREVISTOS PARA OS PRÓXIMOS MESES', 'lancamentos_proximos_meses', ['Descrição', 'Valor (R$)'], 'Nenhum lançamento previsto para os próximos meses.'),
      par('{observacoes_prestacao}', { margin: [0, 0, 0, 8] }),
      assinaturas(['ADMINISTRADORA — {imobiliaria_nome}']),
      disclaimer(),
    ],

    // 16. AUTORIZAÇÃO CAIXA — PESQUISA CADASTRAL
    autorizacao_caixa_pesquisa_cadastral: [
      titulo('AUTORIZAÇÃO PARA PESQUISA CADASTRAL E/OU SALDO DE FGTS'),
      labelPar('UNIDADE / AGÊNCIA (opcional):', '{^ul_cca_nome}—{/ul_cca_nome}{ul_cca_nome}{#ul_cca_codigo}, código {ul_cca_codigo}{/ul_cca_codigo}.'),
      par('Consultas autorizadas nesta pesquisa:', { margin: [0, 10, 0, 2] }),
      par('{#consulta_cadastral_proponentes_bool}• Pesquisa Cadastral do(s) Proponente(s)/Coobrigado(s)/Cônjuge(s).{/consulta_cadastral_proponentes_bool}', { margin: [0, 0, 0, 2] }),
      par('{#consulta_cadastral_vendedores_bool}• Pesquisa Cadastral do(s) Vendedor(es)/Cônjuge(s).{/consulta_cadastral_vendedores_bool}', { margin: [0, 0, 0, 2] }),
      par('{#consulta_saldo_fgts_bool}• Pesquisa do Saldo da Conta Vinculada do FGTS do(s) Proponente(s)/Coobrigado(s)/Cônjuge(s).{/consulta_saldo_fgts_bool}', { margin: [0, 0, 0, 2] }),
      par('{#consulta_fgts_tres_anos_bool}• Verificação se o(s) Proponente(s)/Coobrigado(s)/Cônjuge(s) possui(em) mais de três anos de FGTS.{/consulta_fgts_tres_anos_bool}', { margin: [0, 0, 0, 10] }),
      labelPar('PROPONENTE:', '{proponente_nome}, CPF nº {proponente_cpf}{#proponente_pis}, PIS nº {proponente_pis}{/proponente_pis}.'),
      par('{#tem_coobrigado}COOBRIGADO(A)/CÔNJUGE: {coobrigado_nome}, CPF nº {coobrigado_cpf}{#coobrigado_pis}, PIS nº {coobrigado_pis}{/coobrigado_pis}.{/tem_coobrigado}', { margin: [0, 4, 0, 8] }),
      par('{#tem_vendedor}VENDEDOR(A)/RAZÃO SOCIAL: {vendedor_nome}, CPF/CNPJ nº {vendedor_cpf_cnpj}.{/tem_vendedor}', { margin: [0, 0, 0, 4] }),
      par('{#tem_conjuge_vendedor}CÔNJUGE DO(A) VENDEDOR(A): {conjuge_vendedor_nome}, CPF nº {conjuge_vendedor_cpf}.{/tem_conjuge_vendedor}', { margin: [0, 0, 0, 8] }),
      par('{#imovel_referencia}IMÓVEL DE REFERÊNCIA: {imovel_referencia}.{/imovel_referencia}', { margin: [0, 0, 0, 10] }),
      par('Eu(nós), o(s) signatário(s) abaixo qualificado(s), autorizo(amos) a CAIXA ECONÔMICA FEDERAL, nos termos das Resoluções BACEN nº 3.920/10 e 4.571/17, conforme detalhado a seguir.', { margin: [0, 10, 0, 8] }),
      clausula(1, 'da consulta ao SCR-BACEN', 'A consultar as informações consolidadas a respeito das operações de crédito e câmbio constantes em meu(nosso) nome no Sistema de Informações de Crédito do Banco Central (SCR-BACEN), gerido pelo Banco Central do Brasil, ou dos sistemas que venham a complementá-lo ou substituí-lo, bem como a fornecer informações sobre as operações de crédito e câmbio por mim(nós) realizadas com a CAIXA, para compor o referido cadastro.'),
      clausula(2, 'da consulta ao FGTS', 'Especificamente no caso do(s) proponente(s)/coobrigado(s)/cônjuge(s), a consultar o sistema do FGTS para verificação de saldos e movimentações, conforme opção(ões) assinalada(s) acima.'),
      clausula(3, 'do arquivamento e da consulta a serviços de proteção ao crédito', 'Ao arquivamento dos meus(nossos) dados cadastrais e, respeitadas as disposições legais em vigor, à consulta e ao arquivamento desses dados nos serviços de proteção ao crédito com os quais a CAIXA mantém convênio firmado, podendo deles se utilizar.'),
      par('Declaro(amos) estar ciente(s) de que o SCR-BACEN é um cadastro que visa prover o Banco Central de informações para fins de monitoramento do crédito no sistema financeiro e para o exercício de suas atividades de fiscalização, servindo ainda para propiciar o intercâmbio de informações entre instituições financeiras, nos termos do art. 4º da Resolução BACEN nº 4.571/17. Tenho(mos) ciência de que poderei(emos) acessar meus(nossos) dados no SCR pelas Centrais de Atendimento ao Público do BACEN e/ou pelo endereço www.bcb.gov.br, e de que pedidos de correção ou exclusão dessas informações devem ser dirigidos à instituição responsável pela remessa dos dados ao BACEN, por requerimento escrito e fundamentado, ou, quando for o caso, por decisão judicial.', { margin: [0, 4, 0, 10] }),
      par('E, por ser esta a expressão de minha(nossa) vontade, firmo(amos) a presente autorização.', { margin: [0, 4, 0, 0] }),
      assinaturas([
        'Assinatura Proponente',
        'Assinatura Coobrigado/Cônjuge',
        'Assinatura Vendedor',
        'Assinatura Cônjuge do Vendedor',
        'Assinatura Vendedor',
        'Assinatura Cônjuge do Vendedor',
        'Assinatura Vendedor',
        'Assinatura Cônjuge do Vendedor',
      ]),
    ],

    // 17. FECHAMENTO DE VENDA — PRESTAÇÃO DE CONTAS AO PROPRIETÁRIO
    fechamento_venda: [
      titulo('FECHAMENTO DE VENDA — PRESTAÇÃO DE CONTAS AO PROPRIETÁRIO'),
      identificacao(),
      labelPar('PROPRIETÁRIO(A)/VENDEDOR(A):', '{vendedor_nome}, CPF/CNPJ nº {vendedor_cpf}.'),
      labelPar('IMÓVEL:', '{imovel_tipo} situado em {imovel_endereco_completo}{#imovel_matricula}, matrícula nº {imovel_matricula}{/imovel_matricula}.'),
      par('A ADMINISTRADORA presta contas ao(à) PROPRIETÁRIO(A)/VENDEDOR(A) acima qualificado(a) quanto ao fechamento da venda do imóvel, discriminando abaixo o valor de venda e os créditos e débitos aplicados até o valor líquido devido.', { margin: [0, 10, 0, 12] }),
      clausula(1, 'do valor de venda', 'O imóvel foi vendido pelo valor de R$ {valor_venda_imovel_fmt} ({valor_venda_imovel_extenso}), que constitui o crédito inicial deste demonstrativo.'),
      tabela('DEMONSTRATIVO DO FECHAMENTO', 'lancamentos_fechamento_lista_processada', ['Descrição', 'Tipo', 'Valor (R$)', 'Saldo (R$)']),
      clausula(2, 'do valor líquido ao proprietário', 'Após os créditos e débitos discriminados acima, o valor líquido devido ao(à) PROPRIETÁRIO(A)/VENDEDOR(A) é de R$ {valor_final_proprietario_fmt}.'),
      clausula(3, 'do repasse', '{#data_prevista_repasse}O valor líquido acima será repassado ao(à) PROPRIETÁRIO(A)/VENDEDOR(A) até o dia {data_prevista_repasse}.{/data_prevista_repasse}{^data_prevista_repasse}A data do repasse será comunicada oportunamente pela ADMINISTRADORA ao(à) PROPRIETÁRIO(A)/VENDEDOR(A).{/data_prevista_repasse}'),
      clausula(4, 'da conferência', 'Esta prestação de contas fica sujeita à conferência pelo(a) PROPRIETÁRIO(A)/VENDEDOR(A), que poderá solicitar esclarecimentos adicionais junto à ADMINISTRADORA no prazo de {prazo_contestacao_fechamento_texto}, contados do recebimento deste documento.'),
      par('{observacoes_fechamento}', { margin: [0, 0, 0, 8] }),
      assinaturas(['PROPRIETÁRIO(A)/VENDEDOR(A) — {vendedor_nome}', 'ADMINISTRADORA — {imobiliaria_nome}']),
      disclaimer(),
    ],

    // PARECER MERCADOLÓGICO DE AVALIAÇÃO IMOBILIÁRIA
    parecer_mercadologico: [
      titulo('PARECER MERCADOLÓGICO DE AVALIAÇÃO IMOBILIÁRIA'),
      identificacao(),
      labelPar('SOLICITANTE:', '{solicitante_nome}, CPF nº {solicitante_cpf}.'),
      labelPar('FINALIDADE:', '{finalidade} do imóvel abaixo descrito, do tipo {tipo_imovel}.'),
      labelPar('IMÓVEL AVALIADO:', '{imovel_avaliado_endereco}{#imovel_avaliado_matricula}, matrícula/inscrição imobiliária nº {imovel_avaliado_matricula}{/imovel_avaliado_matricula}. Área: {imovel_avaliado_area}.'),
      par('{imovel_avaliado_descricao}', { margin: [0, 4, 0, 10] }),
      fotos('foto_imovel', 'FOTOS DO IMÓVEL AVALIADO'),
      par('O presente parecer foi elaborado pelo método comparativo direto de dados de mercado, mediante pesquisa e análise de imóveis de características semelhantes, disponíveis para negociação na mesma região, conforme discriminado a seguir.', { margin: [0, 10, 0, 8] }),
      tabelaComparados('comparados_lista'),
      clausula(1, 'da conclusão e parecer técnico', '{parecer_texto}'),
      labelPar('VALOR SUGERIDO:', 'R$ {valor_sugerido} — {posicionamento_mercado}.'),
      clausula(2, 'da natureza deste documento e da limitação de responsabilidade', 'Este documento constitui um PARECER MERCADOLÓGICO DE AVALIAÇÃO (opinião de valor fundamentada em pesquisa comparativa de mercado), elaborado exclusivamente para fins de orientação comercial de venda ou locação. Não se trata de Parecer Técnico de Avaliação Mercadológica (PTAM) nos moldes das Resoluções COFECI nº 957/2006 e nº 1.066/2007, tampouco de Laudo de Avaliação elaborado nos termos da norma ABNT NBR 14.653, documentos que exigem metodologia técnica mais aprofundada e, no caso do Laudo, responsabilidade técnica de profissional habilitado (engenheiro, arquiteto ou engenheiro agrônomo, com Anotação de Responsabilidade Técnica — ART).'),
      par('Por não seguir o rigor normativo desses documentos, este parecer NÃO possui validade para fins judiciais, periciais, fiscais, de partilha litigiosa, inventário ou garantia de financiamento bancário, servindo unicamente como referência para negociação entre as partes. Caso o(a) solicitante necessite de PTAM ou Laudo de Avaliação com validade técnica para essas finalidades, a ADMINISTRADORA poderá intermediar a elaboração desse serviço mediante contratação específica e valores adicionais, não incluídos neste parecer.', { margin: [0, 4, 0, 8] }),
      par('A ADMINISTRADORA e o avaliador não se responsabilizam por decisões tomadas com base exclusivamente neste parecer, tampouco por variações de mercado posteriores à sua elaboração.', { margin: [0, 0, 0, 0] }),
      labelPar('AVALIADOR:', 'Luiz Gregório Pereira, CRECI nº 35.150, CNAI Avaliador nº 30781.'),
      assinaturas(['{solicitante_nome}', 'AVALIADOR — {imobiliaria_nome}']),
      disclaimer(),
    ],
  };

  // ---------- carregamento de imagens (logo do cabeçalho e marca d'água) ----------
  // Se a imagem falhar por qualquer motivo (rede, caminho, etc.), retorna null
  // em vez de travar/rejeitar — o PDF ainda deve ser gerado, só que sem o logo.
  let imagensCache = null;
  function carregarImagemDataUrl(caminho) {
    return fetch(caminho)
      .then((resp) => {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.blob();
      })
      .then((blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('falha ao ler imagem'));
        reader.readAsDataURL(blob);
      }))
      .catch((err) => {
        console.error('doc-pdf: falha ao carregar imagem', caminho, err);
        return null;
      });
  }

  function obterImagensPdf() {
    if (imagensCache) return imagensCache;
    imagensCache = Promise.all([
      carregarImagemDataUrl('assets/logo-header.png'),
      carregarImagemDataUrl('assets/logo-watermark.png'),
      carregarImagemDataUrl('assets/assinatura-gregorio.png'),
    ]).then(([logoHeader, logoWatermark, assinatura]) => ({ logoHeader, logoWatermark, assinatura }));
    return imagensCache;
  }

  // ---------- geração do PDF final ----------
  // textoPersonalizado (opcional): texto salvo por gerente/admin (parágrafos
  // separados por linha em branco) que substitui o corpo padrão do modelo.
  // O título, a identificação da imobiliária, as assinaturas, as testemunhas
  // e o aviso legal continuam sempre fixos/automáticos.
  // Monta o corpo (parágrafos editáveis + tabelas de lançamentos, se houver),
  // preservando a ORDEM ORIGINAL em que os blocos foram declarados no modelo.
  // Quando há texto personalizado (override salvo por gerente/admin), o texto
  // livre substitui os parágrafos, mas eventuais tabelas de lançamentos
  // continuam sendo geradas (não fazem parte do texto editável) e são
  // anexadas ao final do corpo, antes das assinaturas.
  function construirCorpo(blocos, dados, textoPersonalizado) {
    if (textoPersonalizado && textoPersonalizado.trim()) {
      const paragrafos = textoPersonalizado.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
        .map((p) => paragrafoEditavelParaPdf(resolverTexto(p, dados)));
      const tabelas = blocos.filter((b) => b.tipo === 'tabela').map((b) => blocoParaPdf(b, dados));
      return [...paragrafos, ...tabelas].filter(Boolean);
    }
    const itens = [];
    blocos.forEach((b) => {
      if (TIPOS_CORPO_EDITAVEL.includes(b.tipo)) {
        const el = paragrafoEditavelParaPdf(resolverTexto(blocoCorpoParaTexto(b), dados));
        if (el) itens.push(el);
      } else if (b.tipo === 'tabela') {
        const el = blocoParaPdf(b, dados);
        if (el) itens.push(el);
      }
    });
    return itens;
  }

  async function gerarPdfDocumento(modelo, dados, textoPersonalizado) {
    const blocos = MODELOS_DOC_BLOCOS[modelo.id];
    if (!blocos) throw new Error('Modelo sem conteúdo de PDF configurado: ' + modelo.id);
    const estrutura = extrairEstrutura(blocos);
    const imagens = await obterImagensPdf();

    const corpoConteudo = construirCorpo(blocos, dados, textoPersonalizado);

    const content = [
      estrutura.titulo && blocoParaPdf(estrutura.titulo, dados, imagens),
      estrutura.identificacao && blocoParaPdf(estrutura.identificacao, dados, imagens),
      ...corpoConteudo,
      estrutura.assinaturas && blocoParaPdf(estrutura.assinaturas, dados, imagens),
      estrutura.testemunhas && blocoParaPdf(estrutura.testemunhas, dados, imagens),
      estrutura.disclaimer && blocoParaPdf(estrutura.disclaimer, dados, imagens),
    ].filter(Boolean);
    const footerTexto = resolverTexto('{data_extenso}  ·  {imobiliaria_endereco_completo}  ·  {imobiliaria_telefone}', dados);
    // modelo.semBranding: para modelos que precisam ser uma cópia neutra de
    // um formulário oficial de terceiro (ex.: autorização Caixa) — sem logo,
    // sem marca d'água e sem rodapé com dados da imobiliária, já que o
    // documento não deve trazer identificação da Gregório | Meu Lar.
    const semBranding = !!modelo.semBranding;

    const docDefinition = {
      pageSize: 'A4',
      pageMargins: [50, 80, 50, 56],
      header(currentPage, pageCount, pageSize) {
        const stack = [];
        if (imagens.logoHeader && !semBranding) stack.push({ image: imagens.logoHeader, width: 34, alignment: 'center', margin: [0, 16, 0, 6] });
        stack.push({ canvas: [{ type: 'line', x1: 40, y1: 0, x2: pageSize.width - 40, y2: 0, lineWidth: 1, lineColor: '#c9ccd6' }], margin: (imagens.logoHeader && !semBranding) ? [0, 0, 0, 0] : [0, 20, 0, 0] });
        return { stack };
      },
      footer(currentPage, pageCount, pageSize) {
        if (semBranding) {
          return {
            stack: [
              { canvas: [{ type: 'line', x1: 40, y1: 0, x2: pageSize.width - 40, y2: 0, lineWidth: 0.75, lineColor: '#dddddd' }], margin: [0, 4, 0, 4] },
              { text: resolverTexto('{data_extenso}', dados), alignment: 'center', fontSize: 8, color: '#888888' },
            ],
          };
        }
        return {
          stack: [
            { canvas: [{ type: 'line', x1: 40, y1: 0, x2: pageSize.width - 40, y2: 0, lineWidth: 0.75, lineColor: '#dddddd' }], margin: [0, 4, 0, 4] },
            { text: footerTexto, alignment: 'center', fontSize: 8, color: '#888888' },
          ],
        };
      },
      background(currentPage, pageSize) {
        if (semBranding || !imagens.logoWatermark) return { canvas: [] };
        const w = 300;
        return { image: imagens.logoWatermark, width: w, absolutePosition: { x: (pageSize.width - w) / 2, y: (pageSize.height - w) / 2 } };
      },
      content,
      styles: {
        titulo: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 4, 0, 6] },
        identificacao: { fontSize: 8.5, italics: true, color: '#555555', alignment: 'center', margin: [0, 0, 0, 4] },
        corpo: { fontSize: 10.5, alignment: 'justify', margin: [0, 0, 0, 9], lineHeight: 1.18 },
        subitem: { fontSize: 10.5, alignment: 'justify', margin: [26, 0, 0, 9], lineHeight: 1.18 },
        assinData: { fontSize: 10.5, alignment: 'center', margin: [0, 24, 0, 20] },
        disclaimer: { fontSize: 8, italics: true, color: '#666666', margin: [0, 18, 0, 0] },
      },
      defaultStyle: { font: 'Roboto', fontSize: 10.5 },
    };

    const nomeBase = dados[modelo.nomeArquivoTag] || modelo.titulo;
    const nomeArquivo = `${modelo.id}-${slugArquivo(nomeBase)}-${dataHojeArquivo()}.pdf`;

    // Usa getBlob + link manual (mesmo padrão comprovado usado no resto do CRM)
    // em vez do .download() interno do pdfmake, com um limite de tempo para
    // nunca travar em silêncio caso a geração do PDF trave por algum motivo.
    //
    // IMPORTANTE: a partir da reescrita 0.3.x do pdfmake, getBlob() (assim como
    // getBuffer()/getBase64()) deixou de aceitar callback e passou a retornar uma
    // Promise (`const blob = await pdfMake.createPdf(docDefinition).getBlob()`).
    // Chamar no estilo antigo — getBlob((b) => {...}) — não gera erro nenhum,
    // apenas nunca invoca o callback, travando a geração em silêncio até estourar
    // o tempo limite abaixo. Suportamos os dois estilos para não quebrar de novo
    // caso o CDN sirva uma versão 0.2.x no futuro.
    const geradorPdf = pdfMake.createPdf(docDefinition);
    const blob = await new Promise((resolve, reject) => {
      let resolvido = false;
      const tempoLimite = setTimeout(() => {
        if (!resolvido) { resolvido = true; reject(new Error('tempo excedido ao montar o PDF')); }
      }, 20000);
      const finalizarOk = (b) => {
        if (resolvido) return;
        resolvido = true;
        clearTimeout(tempoLimite);
        resolve(b);
      };
      const finalizarErro = (err) => {
        if (resolvido) return;
        resolvido = true;
        clearTimeout(tempoLimite);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      try {
        const resultado = geradorPdf.getBlob(finalizarOk);
        // pdfmake 0.3.x: getBlob() retorna a própria Promise do blob (ignora o
        // callback acima). pdfmake 0.2.x: getBlob(cb) não retorna nada usável.
        if (resultado && typeof resultado.then === 'function') {
          resultado.then(finalizarOk, finalizarErro);
        }
      } catch (err) {
        finalizarErro(err);
      }
    });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = nomeArquivo;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);

    // Devolve o blob e o nome do arquivo para quem chamou (app.js) poder
    // registrar o documento no histórico (tabela documentos_gerados) sem
    // precisar gerar o PDF de novo.
    return { blob, nomeArquivo };
  }

  window.gerarPdfDocumento = gerarPdfDocumento;
  window.MODELOS_DOC_BLOCOS_DISPONIVEIS = Object.keys(MODELOS_DOC_BLOCOS);
  window.obterTextoModeloPadrao = function (modeloId) {
    const blocos = MODELOS_DOC_BLOCOS[modeloId];
    if (!blocos) return '';
    return extrairEstrutura(blocos).corpo.map(blocoCorpoParaTexto).filter(Boolean).join('\n\n');
  };
})();
