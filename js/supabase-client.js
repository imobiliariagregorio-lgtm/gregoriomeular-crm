// =====================================================================
// CONFIGURAÇÃO DO SUPABASE — CRM
// Gregório | Meu Lar Imobiliária
// Carregado como <script> clássico (não-module) para funcionar em
// qualquer navegador de celular, inclusive os que não suportam
// módulos ES (ex.: navegadores "economia de dados"/embutidos).
// A biblioteca do Supabase é carregada antes deste arquivo via
// <script src=".../supabase-js@2/dist/umd/supabase.js"></script>,
// que expõe window.supabase.createClient(...).
// =====================================================================

const SUPABASE_URL = 'https://yiyhspddvrypifxfzzdm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_JQK9ls0HmQDrGGOW8ClvDA_ehiFAUJd';

// IMPORTANTE: a lib UMD carregada acima já cria uma variável global
// "supabase" (o namespace da biblioteca). Aqui reaproveitamos esse
// mesmo global (sem "const"/"let", só atribuição) para virar o
// cliente conectado — assim não há conflito de redeclaração entre
// os dois <script> tags, e o resto do código (app.js, doc-pdf.js)
// continua usando "supabase.from(...)", "supabase.auth...", etc.
supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
