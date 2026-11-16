// Configuração de conexão com o Supabase do projeto Atacama_2027.
// A anon key é segura para uso no cliente: o acesso de leitura/escrita
// é protegido por Row Level Security no banco e por um PIN de acesso no app.
window.SUPABASE_URL = "https://jiqpgzxuvswnrtxvtabo.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppcXBnenh1dnN3bnJ0eHZ0YWJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3ODA2MjEsImV4cCI6MjExMDM1NjYyMX0.i3KiLVDbaj5PtX8ckxV88T4yySYeLTxg6ZpzO9_zMZQ";

// PIN de acesso ao app (apenas uma camada simples no navegador,
// não é autenticação real). Altere livremente editando esta linha.
window.APP_PIN = "2027";
