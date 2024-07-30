'use strict'

const express = require('express');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
require('dotenv').config()

const REQUIRED_ENV_VARS = {
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    HOST: process.env.HOST,
    PORT: process.env.PORT
};

let hasEnvErrors = false;

for (const [key, value] of Object.entries(REQUIRED_ENV_VARS)) {
    if (!value) {
        console.error(`The following environment variable is missing: ${key}`);
        hasEnvErrors = true;
    }
}

if (hasEnvErrors) process.exit(1);

const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

const app = express();
const expressWs = require('express-ws')(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Queues to store messages for each WebSocket session
const messageQueues = new Map();
const conversationHistories = new Map();
const conversationRecordings = new Map();

function debug(message) {
    console.log(`[DEBUG ${new Date().toISOString()}] ${message}`);
}

app.get('/webhooks/answer', (req, res) => {
    let nccoResponse = [
        {
            "action": "connect",
            "from": "NexmoTest",
            "endpoint": [
                {
                    "type": "websocket",
                    "uri": `ws://${process.env.HOST}:${process.env.PORT}/socket`,
                    "content-type": "audio/l16;rate=8000",
                }
            ]
        }
    ]

    res.status(200).json(nccoResponse);
});

app.post('/webhooks/events', (req, res) => {
    console.log(req.body)
    res.sendStatus(200);
});

function writeWAVFile(buffer, sampleRate, filepath) {
    const fileSize = buffer.length + 44;
    const wavBuffer = Buffer.alloc(fileSize);

    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(fileSize - 8, 4);
    wavBuffer.write('WAVE', 8);
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16);
    wavBuffer.writeUInt16LE(1, 20);
    wavBuffer.writeUInt16LE(1, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(sampleRate * 2, 28);
    wavBuffer.writeUInt16LE(2, 32);
    wavBuffer.writeUInt16LE(16, 34);
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(buffer.length, 40);

    buffer.copy(wavBuffer, 44);

    fs.writeFileSync(filepath, wavBuffer);
}

function calculateEnergy(buffer) {
    let energy = 0;
    for (let i = 0; i < buffer.length; i += 2) {
        const sample = buffer.readInt16LE(i);
        energy += sample * sample;
    }
    return energy / (buffer.length / 2);
}

function processAudioFile(wsId, transcription) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: { wsId, history: conversationHistories.get(wsId) || [], transcription }
        });

        worker.on('message', (message) => {
            if (message.type === 'updateHistory') {
                conversationHistories.set(wsId, message.history);
            } else {
                const queue = messageQueues.get(wsId);
                if (queue) {
                    queue.push(message);
                }
            }
            resolve();
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });
    });
}

if (isMainThread) {
    app.ws('/socket', (ws, req) => {
        console.log('Phone call begins');

        const wsId = Date.now().toString();
        messageQueues.set(wsId, []);
        conversationHistories.set(wsId, []);
        conversationRecordings.set(wsId, Buffer.alloc(0));

        let isRecording = false;
        let silenceCounter = 0;
        let transcription = "";
        let keepAlive;
        const ENERGY_THRESHOLD = 300;
        const SILENCE_THRESHOLD = 25;

        const deepgram = deepgramClient.listen.live({
            model: "nova-2-voicemail",
            sample_rate: 8000,
            channels: 1,
            encoding: "linear16",
        });
    
        if (keepAlive) clearInterval(keepAlive);
            keepAlive = setInterval(() => {
            deepgram.keepAlive();
        }, 10 * 1000);
    
        deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
            deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
                transcription += data["channel"]["alternatives"][0]["transcript"];
            });
        
            deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
                clearInterval(keepAlive);
                deepgram.finish();
            });
        
            deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
                console.error(error);
            });
        });

        ws.on('message', (data) => {
            if (data instanceof Buffer) {
                deepgram.send(data);
                conversationRecordings.set(wsId, Buffer.concat([conversationRecordings.get(wsId), data]));

                const energy = calculateEnergy(data);

                if (energy > ENERGY_THRESHOLD) {
                    if (!isRecording) {
                        console.log('Speech detected, starting recording');
                        isRecording = true;
                    }
                    silenceCounter = 0;
                } else if (isRecording) {
                    silenceCounter++;

                    if (silenceCounter >= SILENCE_THRESHOLD) {
                        console.log('Silence detected, stopping recording');
                        isRecording = false;
                        deepgram.send(JSON.stringify({ type: "Finalize" }));

                        if (transcription !== "" && transcription.length > 1) {
                            console.log('Transcription:', transcription);
                            processAudioFile(wsId, transcription).catch(console.error);
                        }

                        transcription = "";
                    }
                }
            }

            const queue = messageQueues.get(wsId);
            while (queue && queue.length > 0) {
                const message = queue.shift();
                if (message.type === 'audioChunk') {
                    conversationRecordings.set(wsId, Buffer.concat([conversationRecordings.get(wsId), message.chunk]));
                    ws.send(message.chunk);
                } else if (message.type === 'error') {
                    console.error('Error in worker thread:', message.error);
                    ws.send(JSON.stringify({ type: 'error', message: message.error }));
                }
            }
        });

        ws.on('close', () => {
            console.log('Phone call hung up');
            
            const recordedConversation = conversationRecordings.get(wsId);
            const wavFilename = `full_conversation_${wsId}.wav`;
            const wavFilePath = wavFilename
            writeWAVFile(recordedConversation, 8000, wavFilePath);

            conversationHistories.delete(wsId);
            messageQueues.delete(wsId);
            conversationRecordings.delete(wsId);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });

    app.listen(process.env.PORT, () => console.log(`Listening on port ${process.env.PORT}`));
} else {
    const { wsId, history, transcription } = workerData;

    (async () => {
        debug(`Worker: Processing transcription for wsId: ${wsId}`);
        
        const userMessage = {
            role: "user",
            content: transcription
        };

        history.push(userMessage);

        const { responseText, updatedHistory } = await getResponseCompletion(wsId, history);

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                "Xi-Api-Key": process.env.ELEVENLABS_API_KEY
            },
            body: JSON.stringify({
                text: responseText,
                model_id: "eleven_turbo_v2_5",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.5,
                    style: 1,
                    use_speaker_boost: true
                },
                seed: 123
            })
        };

        try {
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}?optimize_streaming_latency=4&output_format=pcm_16000`, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            let buffer = Buffer.alloc(0);

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                buffer = Buffer.concat([buffer, Buffer.from(value)]);

                while (buffer.length >= 640) { // Process 320 samples (640 bytes) at a time
                    const chunk = buffer.slice(0, 640);
                    buffer = buffer.slice(640);

                    // Downsample from 16kHz to 8kHz by taking every other sample
                    const downsampledChunk = Buffer.alloc(320);
                    for (let i = 0; i < 320; i += 2) {
                        if (i < downsampledChunk.length) {
                            const sample = chunk.readInt16LE(i * 2);
                            downsampledChunk.writeInt16LE(sample, i);
                        }
                    }

                    parentPort.postMessage({ type: 'audioChunk', chunk: downsampledChunk });
                }
            }

            // Process any remaining data
            if (buffer.length >= 4) { // Ensure we have at least 2 samples to process
                const remainingChunk = buffer.slice(0, buffer.length - (buffer.length % 4));
                const downsampledChunk = Buffer.alloc(remainingChunk.length / 2);
                for (let i = 0; i < downsampledChunk.length; i += 2) {
                    if (i < downsampledChunk.length) {
                        const sample = remainingChunk.readInt16LE(i * 2);
                        downsampledChunk.writeInt16LE(sample, i);
                    }
                }
                parentPort.postMessage({ type: 'audioChunk', chunk: downsampledChunk });
            }
        } catch (err) {
            console.error('Error:', err);
            parentPort.postMessage({ type: 'error', error: err.message });
        }

        parentPort.postMessage({ type: 'updateHistory', history: updatedHistory });
    })();
}

async function getResponseCompletion(wsId, history) {
    const msgs = [
        {
            role: "system",
            content: "Your name is carter. You are on a phone call, so your responses MUST be breif. Make sure to introduce yourself. Your response will be spoken to the other person on the call, so don't include any actions just speech.",
        },
        ...history
    ];

    const response = await groq.chat.completions.create({
        messages: msgs,
        model: "llama-3.1-70b-versatile",
    });

    const assistantMessage = {
        role: "assistant",
        content: response.choices[0]?.message?.content || ""
    };
    
    history.push(assistantMessage);

    return { responseText: assistantMessage.content, updatedHistory: history };
}
