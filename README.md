# KAIROS RH — Master Pumps

Assistente Autônomo de Recursos Humanos construído sobre a arquitetura V3 (Express + Groq Llama + Whisper).

## Funcionalidades
- **Gestão de Pessoas:** Ponto, férias, faltas e banco de horas.
- **Relatórios Executivos:** Resumos diários gerados proativamente pelas manhãs.
- **Interação Natural:** Suporte total a áudio (transcrição via Whisper) e texto.
- **Robustez (V3):** Autocorreção de saídas LLM, ping server (Express) e tolerância a falhas do Telegram.

## Como fazer o deploy (Render)
1. Crie um **Web Service** na [Render.com](https://render.com).
2. Conecte este repositório.
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Adicione as variáveis de ambiente (`Environment Variables`):
   - `TELEGRAM_BOT_TOKEN`: Token do bot criado no BotFather (@Kairosmasterpumpstombot)
   - `GROQ_API_KEY`: Chave da API da Groq

O bot iniciará automaticamente e fará o binding na porta `$PORT` para manter o serviço ativo 24/7.
