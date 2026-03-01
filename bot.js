require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const { getSystemPrompt, MOCK_LABEL } = require('./data');

// ── Config ──────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
    console.error('❌ Defina TELEGRAM_BOT_TOKEN e GROQ_API_KEY no .env');
    process.exit(1);
}

// ── Express Server para o Render ───────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🤖 KAIROS RH Master Pumps Bot (v3.0) está Online e operando!');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`🌐 Servidor Web escutando na porta ${PORT}`);
});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// ── State ───────────────────────────────────────────────────
const conversations = new Map();
const userContext = new Map();    // Stores gathered context per chat
const onboardingState = new Map(); // Tracks onboarding step per chat

const CONTEXT_FILE = path.join(__dirname, 'context.json');

// Load saved context if exists
let defaultContext = null;
if (fs.existsSync(CONTEXT_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
        // Check for pre-filled 'default' context
        if (saved.default) {
            defaultContext = saved.default;
            console.log('📂 Contexto pré-preenchido encontrado (Wellington)');
        }
        // Load per-chatId contexts
        Object.entries(saved).forEach(([k, v]) => {
            if (k !== 'default') userContext.set(Number(k), v);
        });
    } catch (e) { }
}

function saveContext() {
    const obj = {};
    if (defaultContext) obj.default = defaultContext;
    userContext.forEach((v, k) => obj[k] = v);
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(obj, null, 2));
}

// Propagate default context to a new chatId
function ensureContext(chatId) {
    if (!userContext.has(chatId) && defaultContext) {
        userContext.set(chatId, { ...defaultContext });
        saveContext();
        console.log(`📋 Contexto padrão aplicado para chat ${chatId}`);
    }
}

// ── Funções de Base (V3) ───────────────────────────────────
async function safeSend(chatId, text, extra = {}) {
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
    } catch {
        try {
            await bot.sendMessage(chatId, text, extra);
        } catch (err2) {
            console.error('safeSend fatal:', err2.message);
        }
    }
}

console.log('🎙️ KAIROS RH — Assistente de Voz do Supervisor de RH (Master Pumps)');
console.log('   Modo: Demo com dados ilustrativos + Contexto real do Wellington');
console.log('   Aguardando comandos...\n');

// ── Onboarding Questions ────────────────────────────────────
const ONBOARDING_QUESTIONS = [
    {
        key: 'nome',
        question: '👤 Para começar, qual o seu *nome completo* e *cargo* na empresa?',
    },
    {
        key: 'equipe_rh',
        question: '👥 Quantas pessoas compõem o time de RH hoje? (pode enviar por áudio se preferir)',
    },
    {
        key: 'total_funcionarios',
        question: '🏭 Quantos colaboradores a empresa tem hoje no total? (Matriz + Filial)',
    },
    {
        key: 'dores_principais',
        question: '🔥 Qual é a *maior dor* que você enfrenta no dia a dia do RH? O que mais toma seu tempo ou gera estresse? (pode desabafar à vontade, por texto ou áudio)',
    },
    {
        key: 'sistemas_atuais',
        question: '💻 Vocês usam algum sistema de ponto, folha ou gestão de RH? Se sim, quais?',
    },
    {
        key: 'documentos',
        question: '📄 Perfeito. Para eu me tornar realmente útil, você poderia me enviar os documentos-chave do RH? Por exemplo:\n\n• Política de banco de horas\n• Regras de férias\n• Tabela de cargos e salários\n• Organograma atualizado\n• Qualquer manual interno\n\nPode enviar *fotos, PDFs ou arquivos* aqui mesmo. Quando terminar de enviar tudo, digite *"pronto"* que eu processo.',
    },
];

// ── STT: Groq Whisper ──────────────────────────────────────
async function transcribeAudio(filePath) {
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', 'whisper-large-v3');
    form.append('language', 'pt');
    form.append('response_format', 'text');

    const response = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        form,
        {
            headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                ...form.getHeaders(),
            },
            maxContentLength: Infinity,
        }
    );
    return response.data.trim();
}

// ── LLM: Groq Chat ─────────────────────────────────────────
async function askKairosRH(chatId, userMessage) {
    if (!conversations.has(chatId)) {
        conversations.set(chatId, []);
    }
    const history = conversations.get(chatId);
    history.push({ role: 'user', content: userMessage });
    const recentHistory = history.slice(-10);

    // Build enhanced system prompt with user context
    let systemPrompt = getSystemPrompt();
    const ctx = userContext.get(chatId);
    if (ctx && Object.keys(ctx).length > 0) {
        systemPrompt += `\n\nCONTEXTO REAL FORNECIDO PELO SUPERVISOR:\n${JSON.stringify(ctx, null, 2)}\n\nQuando tiver dados reais acima, priorize-os sobre os dados ilustrativos. Mencione que os dados ilustrativos servem apenas como exemplo do que o sistema pode fazer quando estiver 100% configurado.`;
    }

    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                ...recentHistory,
            ],
            temperature: 0.7,
            max_tokens: 400,
        },
        {
            headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json',
            },
        }
    );

    const assistantMessage = response.data.choices[0].message.content;
    history.push({ role: 'assistant', content: assistantMessage });
    return assistantMessage;
}

// ── TTS: Edge-TTS via CLI ──────────────────────────────────
async function synthesizeSpeech(text, outputPath) {
    return new Promise((resolve, reject) => {
        const safeText = text
            .replace(/"/g, '\\"')
            .replace(/\n/g, ' ')
            .replace(/[`$]/g, '');

        const voice = 'pt-BR-AntonioNeural';
        const cmd = `npx -y edge-tts --voice "${voice}" --text "${safeText}" --write-media "${outputPath}"`;

        exec(cmd, { timeout: 30000 }, (error) => {
            if (error) {
                console.error('TTS Error:', error.message);
                reject(error);
            } else {
                resolve(outputPath);
            }
        });
    });
}

// ── Download & transcribe voice helper ─────────────────────
async function getVoiceText(msg) {
    const fileId = msg.voice.file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const oggPath = path.join(TEMP_DIR, `voice_${Date.now()}.ogg`);

    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(oggPath, response.data);

    const transcript = await transcribeAudio(oggPath);
    try { fs.unlinkSync(oggPath); } catch (e) { }
    return transcript;
}

// ── Onboarding Flow ────────────────────────────────────────
async function handleOnboarding(chatId, inputText) {
    const step = onboardingState.get(chatId) || 0;

    if (step < ONBOARDING_QUESTIONS.length) {
        const q = ONBOARDING_QUESTIONS[step];

        // Store the answer (skip if this is the first call — no answer yet)
        if (step > 0 || inputText !== '__START__') {
            const prevQ = ONBOARDING_QUESTIONS[step > 0 ? step - 1 : 0];
            if (inputText !== '__START__') {
                if (!userContext.has(chatId)) userContext.set(chatId, {});
                const ctx = userContext.get(chatId);

                // Special handling for "pronto" on docs question
                if (prevQ.key === 'documentos' && inputText.toLowerCase() === 'pronto') {
                    // Done with onboarding
                    onboardingState.delete(chatId);
                    saveContext();
                    await bot.sendMessage(chatId,
                        `✅ *Onboarding completo!*\n\n` +
                        `Agora tenho contexto sobre a sua operação real. Vou mesclar o que você me contou com os dados ilustrativos para te dar respostas cada vez mais precisas.\n\n` +
                        `A partir de agora, pode me perguntar qualquer coisa — por *texto* ou *áudio*. Eu sou seu assistente de RH 24h.\n\n` +
                        `💡 Dica: Use /relatorio para o briefing matinal completo.`,
                        { parse_mode: 'Markdown' }
                    );
                    return true;
                }

                ctx[prevQ.key] = inputText;
                saveContext();
            }
        }

        // If we just stored the last non-docs answer, or it's docs and not "pronto"
        if (step < ONBOARDING_QUESTIONS.length) {
            const nextQ = ONBOARDING_QUESTIONS[step];
            await bot.sendMessage(chatId, nextQ.question, { parse_mode: 'Markdown' });
            onboardingState.set(chatId, step + 1);
        }

        return true; // Signal that we're in onboarding
    }

    return false; // Not in onboarding
}

// ── Handler: /start ─────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    ensureContext(chatId);

    await safeSend(chatId,
        `🏭 *KAIROS RH — Master Pumps*\n\n` +
        `Wellington, sou o *KAIROS RH*, seu Assistente Autônomo de Recursos Humanos. Fui configurado especificamente para a operação da Master Pumps.\n\n` +
        `Aqui está o que eu faço por você:\n\n` +
        `📋 *Gestão de Pessoas*\n` +
        `• Controlar faltas, atestados e ocorrências\n` +
        `• Gerenciar banco de horas e alertar excessos\n` +
        `• Acompanhar onboardings de novos colaboradores\n\n` +
        `📊 *Relatórios Executivos*\n` +
        `• Briefing matinal completo do RH\n` +
        `• Resumo da folha e custo total\n` +
        `• Métricas prontas para a diretoria\n\n` +
        `📖 *Políticas da Empresa*\n` +
        `• Responder dúvidas de férias, VT, horários\n` +
        `• Orientar funcionários sobre normas internas\n` +
        `• Escalar questões complexas para a Juliana\n\n` +
        `🎓 *Treinamentos e Compliance*\n` +
        `• Alertar vencimento de NRs obrigatórias\n` +
        `• Controlar CIPA, integração e SGQ\n\n` +
        `🎧 *Interface de Voz*\n` +
        `• Me envie áudios e eu respondo por áudio\n` +
        `• Transcrevo tudo automaticamente\n\n` +
        `───────────────────────\n` +
        `✅ _Contexto carregado: ~127 colaboradores, Matriz + Filial, organogramas e políticas de RH._\n\n` +
        `Pode me perguntar qualquer coisa — por *texto* ou *áudio*.\n` +
        `📊 /relatorio — Briefing matinal completo\n` +
        `🔄 /onboarding — Atualizar dados do sistema`
    );
});

// ── Handler: /onboarding (reconfigure) ──────────────────────
bot.onText(/\/onboarding/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId,
        `🔧 *Modo de Reconfiguração*\n\n` +
        `Vou te fazer 6 perguntas para atualizar o meu contexto. Pode responder por *texto ou áudio*. Ao final, pode enviar documentos atualizados.\n\nVamos lá 👇`,
        { parse_mode: 'Markdown' }
    );
    await new Promise(r => setTimeout(r, 1000));
    onboardingState.set(chatId, 0);
    await handleOnboarding(chatId, '__START__');
});

// ── Handler: /relatorio ─────────────────────────────────────
bot.onText(/\/relatorio/, async (msg) => {
    const chatId = msg.chat.id;
    ensureContext(chatId);
    await bot.sendChatAction(chatId, 'typing');
    const report = await askKairosRH(chatId,
        'Gere o relatório matinal completo do RH para o Wellington: ocorrências do dia (faltas, atestados, acidentes), onboardings pendentes, alertas de banco de horas, treinamentos vencendo, férias próximas e resumo da folha. Ao final, adicione uma seção curta "Oportunidade de Otimização" com 1-2 insights sobre como a automação de RH poderia reduzir custos ou tempo naquele período. Formate de forma organizada e executiva.'
    );
    await safeSend(chatId, `📊 *Briefing Matinal KAIROS RH — Master Pumps*\n\n${report}`);
});

// ── Handler: Voice Messages ─────────────────────────────────
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    ensureContext(chatId);

    try {
        await bot.sendMessage(chatId, '🎙️ _Processando seu áudio..._', { parse_mode: 'Markdown' });

        const transcript = await getVoiceText(msg);
        console.log(`📝 [${chatId}] Transcrição: "${transcript}"`);

        await bot.sendMessage(chatId, `📝 *Transcrição:* _"${transcript}"_`, { parse_mode: 'Markdown' });

        // Check if in onboarding
        if (onboardingState.has(chatId)) {
            await handleOnboarding(chatId, transcript);
            return;
        }

        // Regular flow
        console.log('🧠 Processando com KAIROS RH...');
        const answer = await askKairosRH(chatId, transcript);
        console.log(`   → ${answer}`);

        await safeSend(chatId, `🤖 ${answer}`);

        // Voice response
        const mp3Path = path.join(TEMP_DIR, `response_${Date.now()}.mp3`);
        try {
            await synthesizeSpeech(answer, mp3Path);
            await bot.sendVoice(chatId, mp3Path);
            fs.unlinkSync(mp3Path);
        } catch (ttsErr) {
            console.log('TTS falhou, enviando só texto:', ttsErr.message);
        }

    } catch (error) {
        console.error('Erro:', error.message);
        await bot.sendMessage(chatId, '⚠️ Houve um problema ao processar seu áudio. Tente novamente.');
    }
});

// ── Handler: Text Messages ──────────────────────────────────
bot.on('message', async (msg) => {
    if (msg.voice || !msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const text = msg.text;

    // Check if in onboarding
    if (onboardingState.has(chatId)) {
        await handleOnboarding(chatId, text);
        return;
    }

    // Regular conversation
    try {
        await bot.sendChatAction(chatId, 'typing');
        const answer = await askKairosRH(chatId, text);
        await safeSend(chatId, `🤖 ${answer}`);

        // Also respond with voice
        const mp3Path = path.join(TEMP_DIR, `response_${Date.now()}.mp3`);
        try {
            await synthesizeSpeech(answer, mp3Path);
            await bot.sendVoice(chatId, mp3Path);
            fs.unlinkSync(mp3Path);
        } catch (ttsErr) {
            console.log('TTS falhou para texto:', ttsErr.message);
        }
    } catch (error) {
        console.error('Erro:', error.message);
        await bot.sendMessage(chatId, '⚠️ Houve um problema. Tente novamente.');
    }
});

// ── Handler: Documents (for onboarding) ─────────────────────
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;

    if (onboardingState.has(chatId)) {
        const fileName = msg.document.file_name || 'documento';
        await bot.sendMessage(chatId, `📎 Recebi o arquivo *${fileName}*. Quando terminar de enviar todos os documentos, digite *"pronto"*.`, { parse_mode: 'Markdown' });

        // Save file reference in context
        if (!userContext.has(chatId)) userContext.set(chatId, {});
        const ctx = userContext.get(chatId);
        if (!ctx.documentos_recebidos) ctx.documentos_recebidos = [];
        ctx.documentos_recebidos.push(fileName);
        saveContext();
        return;
    }

    await bot.sendMessage(chatId, '📎 Recebi seu documento! Posso analisar o conteúdo se você me disser o que é. Ex: "Esse é o organograma atualizado".');
});

// ── Error handling ──────────────────────────────────────────
bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
        console.warn('⚠️  [Aviso] Conflito 409 detectado (possiveis multiplas instancias rodando). Ignorando para permitir transição no Render...');
    } else {
        console.error('Polling error:', error.message);
    }
});

console.log('✅ KAIROS RH ativo. Envie /start no Telegram para iniciar o onboarding.');
