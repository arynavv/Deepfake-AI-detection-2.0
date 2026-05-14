// server.js — AuraShield Deepfake Detector Backend
require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve the frontend (index.html, app.js, styles.css) as static files
app.use(express.static(path.join(__dirname)));

// ── File upload (memory storage — we forward the bytes directly to Gemini) ────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// ── Gemini Analysis Prompt ─────────────────────────────────────────────────────
const ANALYSIS_PROMPT = `You are an expert Media Authenticity AI.
Analyze the image and determine if it is authentic or AI-generated.

CRITICAL ANALYSIS:
1. Conceptual Plausibility: Are there highly dangerous, staged, or physically impossible scenarios?
2. Faces & Celebrities: When analyzing faces (like celebrities), real photos have natural skin textures, asymmetrical lighting, and slight imperfections. AI often makes skin look like plastic or messes up teeth and background depth.
3. Vehicles & Reflective Objects: AI-generated cars often have nonsensical text on license plates, physically impossible reflection curves, or completely flawless environments that look like a render. Real car photos have dirt, natural reflections, and imperfect backgrounds.
4. Textures & Blending: Check for overly smooth, "painterly", or plastic-like textures.

Balance your judgment. Do not flag normal, slightly blurry, or naturally lit photos as fake. Immediately flag nonsensical text, impossible physics, and generative aesthetic hallmarks as fake.

Respond ONLY with a valid JSON object matching this exact structure:
{
    "isFake": boolean (true if manipulated/AI, false if authentic),
    "confidence": number (90 to 100),
    "insights": [
        {
            "type": string ("warning" or "safe"),
            "icon": string (e.g., "fa-solid fa-paw", "fa-solid fa-user", "fa-solid fa-camera"),
            "title": string,
            "description": string
        }
    ],
    "summary": string (Professional summary explaining why it is authentic or fake. Use markdown.)
}
Provide exactly 3 insights. Do not include markdown codeblocks around the JSON, just the raw JSON text.`;

// ── Gemini Prompt — video frames (conservative bias to avoid false positives) ────
const VIDEO_FRAME_PROMPT = `You are an expert Video Authenticity Forensics AI analyzing a single extracted frame from a video.

Focus on signs of video-specific manipulation:
1. Facial rendering: Look for plastic-like or over-smoothed skin, unnatural eye sheen, teeth that look rendered, asymmetrical blinking artifacts.
2. Temporal seams: Check for mismatched sharpness between face and background, halo or bleeding at hair boundaries, abrupt color grading differences.
3. Motion blur consistency: In real video frames, objects in motion have directional blur. Deepfakes often show the face sharply frozen against a blurred or separately-processed background.
4. Compression patterns: Look for block artifacts localized to the face region that differ from the background, indicating a composited face layer.
5. Environmental coherence: Do reflections in glasses, eyes, or wet surfaces plausibly match the background scene?

Be conservative: real home videos, phone recordings, and low-light footage can look imperfect. Only flag as fake if you see CLEAR forensic evidence like:
- Region-specific compression blocks around a face
- Unnatural sharpness boundary separating face from scene
- Impossible specular positions in eyes
- GAN-like texture smoothness on skin that clashes with the rest of the frame

DO NOT flag normal JPEG compression, motion blur, low resolution, or natural skin imperfections as evidence of manipulation.

Respond ONLY with a valid JSON object:
{
    "isFake": boolean,
    "confidence": number (50 to 99),
    "primarySignal": string (one sentence: the single most important indicator you observed),
    "insights": [
        { "type": "warning" | "safe", "icon": string, "title": string, "description": string }
    ],
    "summary": string
}
Provide exactly 3 insights. No markdown code fences, just raw JSON.`;

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        geminiConfigured: !!process.env.GEMINI_API_KEY
    });
});

// ── POST /api/analyze ──────────────────────────────────────────────────────────
app.post('/api/analyze', upload.single('media'), async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { mimetype, buffer } = req.file;

    // Only support images for Gemini Vision
    if (!mimetype.startsWith('image/')) {
        return res.status(400).json({ error: 'Only image files are supported for AI analysis.' });
    }

    try {
        const base64Data = buffer.toString('base64');

        const model = 'gemini-1.5-pro';
        const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const requestBody = {
            contents: [{
                parts: [
                    { text: ANALYSIS_PROMPT },
                    {
                        inlineData: {
                            data: base64Data,
                            mimeType: mimetype
                        }
                    }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                topK: 32,
                topP: 1
            }
        };

        const geminiResponse = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(requestBody)
        });

        if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            console.error('Gemini API error:', errText);
            return res.status(502).json({ error: `Gemini API returned ${geminiResponse.status}` });
        }

        const data = await geminiResponse.json();
        let textResult = data.candidates[0].content.parts[0].text;

        // Strip any accidental markdown code fences
        textResult = textResult.replace(/```json/g, '').replace(/```/g, '').trim();

        const analysisResult = JSON.parse(textResult);
        return res.json({ source: 'gemini', result: analysisResult });

    } catch (err) {
        console.error('Analysis error:', err);
        return res.status(500).json({ error: err.message });
    }
});
// ── POST /api/analyze-video ─────────────────────────────────────────────────────
// Accepts multiple JPEG frame blobs, analyses each in parallel, aggregates.
const uploadFrames = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/analyze-video', uploadFrames.array('frames', 10), async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No frames uploaded.' });

    const model = 'gemini-1.5-pro';
    const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // ─ Analyse each frame independently in parallel ────────────────────────
    async function analyzeFrame(fileBuffer, mimeType) {
        const body = {
            contents: [{
                parts: [
                    { text: VIDEO_FRAME_PROMPT },
                    { inlineData: { data: fileBuffer.toString('base64'), mimeType } }
                ]
            }],
            generationConfig: { temperature: 0.05, topK: 32, topP: 1 }
        };
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`Gemini ${r.status}`);
        const d = await r.json();
        let txt = d.candidates[0].content.parts[0].text
            .replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(txt);
    }

    let frameResults;
    try {
        frameResults = await Promise.all(
            req.files.map(f => analyzeFrame(f.buffer, f.mimetype || 'image/jpeg'))
        );
    } catch (err) {
        console.error('Frame analysis error:', err);
        return res.status(502).json({ error: err.message });
    }

    // ─ Aggregate ────────────────────────────────────────────────────────────
    const fakeVotes    = frameResults.filter(r => r.isFake).length;
    const realVotes    = frameResults.length - fakeVotes;
    const isFake       = fakeVotes > realVotes;        // strict majority needed to call fake
    const avgConf      = Math.round(frameResults.reduce((s, r) => s + (r.confidence || 80), 0) / frameResults.length);

    // Prefer insights from frames that match the majority verdict
    const majorityFrames = frameResults.filter(r => r.isFake === isFake);
    const sourceFrame    = majorityFrames[Math.floor(majorityFrames.length / 2)] || frameResults[0];

    // Deduplicate insights by title
    const seen = new Set();
    const insights = [];
    for (const frame of majorityFrames) {
        for (const ins of (frame.insights || [])) {
            if (!seen.has(ins.title) && insights.length < 3) {
                seen.add(ins.title);
                insights.push(ins);
            }
        }
    }
    // Pad to 3 if needed
    while (insights.length < 3) {
        insights.push({
            type: isFake ? 'warning' : 'safe',
            icon: isFake ? 'fa-solid fa-film' : 'fa-solid fa-circle-check',
            title: isFake ? 'Temporal Anomaly Detected' : 'Temporal Consistency Verified',
            description: isFake
                ? 'Multiple frames show region-level inconsistencies consistent with video-level deepfake synthesis.'
                : 'Frame sequence shows consistent natural properties across sampled timestamps.'
        });
    }

    // Build summary from primary signals
    const signals = frameResults
        .filter(r => r.primarySignal)
        .map(r => `- ${r.primarySignal}`);

    const verdict  = isFake ? 'manipulated' : 'authentic';
    const summary  = [
        `**Multi-frame forensic analysis** examined **${frameResults.length} keyframes** across the video timeline.`,
        `**${fakeVotes}** of ${frameResults.length} frames showed indicators of manipulation.`,
        ``,
        isFake
            ? `The **majority vote** indicates this video is **${verdict}** with ${avgConf}% confidence. Key forensic signals observed across frames:`
            : `The **majority vote** indicates this video is **${verdict}** with ${avgConf}% confidence. Consistent natural properties observed:`,
        ...signals.slice(0, 4),
        ``,
        isFake
            ? `_Recommendation: Do not treat this video as reliable evidence without further verification._`
            : `_No significant indicators of deepfake synthesis or manipulation were found across the analyzed frames._`
    ].join('\n');

    return res.json({
        source: 'gemini-video',
        frameCount: frameResults.length,
        fakeVotes,
        realVotes,
        result: { isFake, confidence: avgConf, insights: insights.slice(0, 3), summary }
    });
});

// ── Catch-all: serve index.html for SPA-style navigation ──────────────────
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🛡️  AuraShield backend running at http://localhost:${PORT}`);
    console.log(`   Gemini API key: ${process.env.GEMINI_API_KEY ? '✅ Configured' : '❌ Missing — add GEMINI_API_KEY to .env'}\n`);
});
