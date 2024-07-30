# Mini Voice Assistant

OpenAI took too long to rollout GPT-4o voice so I made this instead.,

Built with:
- Vonage for phone stuff
- Groq for fast inference of Meta's llama-3.1-70b-versatile
- Elevenlabs for realistic TTS
- Deepgram for realtime transcription

All could be replaced with self-hosted stuff but i don't have enough compute for that.

Best latency can be achived by hosting in US east datacenters. I was able to get responses in as little as 2-3 seconds but I'm in the UK so it can probably go lower.

## Usage

1. `git clone https://github.com/carter-0/mini-voice-assistant && cd cd mini-voice-assistant`
2. `npm i`
3. `mv .env.example .env`
4. Fill in `.env` file and point vonage to your server
5. `node server.js`
6. Call the phone number and start speaking
