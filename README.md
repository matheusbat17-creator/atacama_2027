# Atacama 2027 — App de Planejamento de Viagem

App mobile-first para organizar a viagem ao Deserto do Atacama: voos, hospedagens, passeios, roteiro dia a dia e orçamento. Os dados ficam salvos no Supabase (projeto `Atacama_2027`), então tudo que você adicionar pelo celular fica salvo na nuvem automaticamente — sem precisar voltar numa conversa com o Claude para atualizar nada.

## Estrutura

```
index.html      → estrutura do app (telas e navegação)
css/style.css   → tema visual (deserto + céu noturno do Atacama)
js/config.js    → URL/chave do Supabase e PIN de acesso
js/app.js       → toda a lógica (CRUD com o banco, navegação, cálculo de orçamento)
```

## Banco de dados (Supabase · projeto Atacama_2027)

Tabelas criadas: `trip_info`, `flights`, `accommodations`, `tours`, `itinerary_days`, `itinerary_items`, `expenses`.
Todas com Row Level Security habilitado e uma policy liberando leitura/escrita para a chave anônima — necessário porque o app não tem um sistema de login completo.

**Importante sobre segurança:** a chave anônima do Supabase fica visível no código-fonte do app (isso é normal em qualquer app client-side). Combinado com as policies abertas, isso significa que qualquer pessoa que descubra a URL do app **e também inspecione o código-fonte** teoricamente conseguiria ler/editar os dados direto no banco, ignorando o PIN (que é só uma trava de interface, não autenticação real). Para um planejamento de viagem pessoal (datas, voos, passeios) o risco é baixo, mas é importante saber disso — **nunca guarde números de cartão, senhas ou documentos dentro do app**. Se quiser reforçar isso no futuro, posso implementar autenticação real do Supabase (login por e-mail/senha).

## Hospedagem no GitHub Pages

1. No GitHub, acesse o repositório `atacama_2027` → **Settings → Pages**.
2. Em "Build and deployment", selecione **Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. Salve. Em 1–2 minutos o app estará em `https://matheusbat17-creator.github.io/atacama_2027/`.
4. Adicione essa URL à tela inicial do seu celular (Safari/Chrome → "Adicionar à Tela de Início") para abrir como um app.

## PIN de acesso

Definido em `js/config.js` (`APP_PIN`). Padrão: `2027`. Troque quando quiser editando esse arquivo.

## Como atualizar o app depois

Qualquer alteração de dados (voos, passeios, datas, valores) é feita direto pelo app, no celular — não precisa editar código. Só seria necessário editar os arquivos se você quiser mudar o visual, o PIN ou a estrutura das telas.
