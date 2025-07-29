/* ───────────────────────────────────────────────────────────────
   X-Ray Search → Google CSE → Gemini / OpenAI → HTML stream
   Candidate refinement → Cerebras / OpenAI
   ─────────────────────────────────────────────────────────────── */
const express = require('express');
const axios   = require('axios');
require('dotenv').config();

/* ─── LLM SDKs ────────────────────────────────────────────────── */
const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const cerebras = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });

const OpenAI  = require('openai');
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ─── Server init ─────────────────────────────────────────────── */
const app  = express();
const PORT = process.env.PORT || 10000;

/* ─── Middleware ──────────────────────────────────────────────── */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));          // serve static files

/* ─── Helpers ─────────────────────────────────────────────────── */
function parseCompany(title = '') {
  const parts = title.split(' - ');
  return parts.length >= 3 ? parts[parts.length - 1].trim() : '';
}

/* ───────────  Gemini first (axios), OpenAI fallback  ─────────── */
async function callGemini({ messages, max_tokens = 6000, temperature = 0.8, top_p = 1 }) {
  /* pull out (single) system instruction */
  const sysIdx  = messages.findIndex(m => m.role === 'system');
  const sysText = sysIdx > -1 ? messages[sysIdx].content : '';
  const userMsgs = messages.filter((_, i) => i !== sysIdx);

  const contents = userMsgs.map(m => ({
    parts: [{ text: m.content }],
    /* role is optional; include when present */
    ...(m.role ? { role: m.role } : {})
  }));

  const body = {
    contents,
    system_instruction: sysText
      ? { parts: [{ text: sysText }] }
      : undefined,
    generationConfig: {
      responseMimeType: 'text/plain',
      maxOutputTokens: max_tokens,
      temperature,
      topP: top_p
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  try {
    console.log('[Gemini] POST', url, JSON.stringify(body));
    const { data } = await axios.post(url, body);
    const txt = data?.candidates?.[0]?.content?.parts
      ?.map(p => p.text)
      .join('')
      .trim() || '';
    /* keep only the last non-empty line to drop any “thinking” */
    return txt.split('\n').filter(l => l.trim()).pop().trim();
  } catch (err) {
    console.error('[Gemini] Error:', err.response?.status, err.response?.data || err.message);
    const transient = err?.response?.status === 429 || /rate limit|ECONN|timeout/i.test(err.message || '');
    if (!transient) throw err;

    console.warn('Gemini unavailable → falling back to OpenAI');
    const oa = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens,
      temperature,
      top_p,
      stream: false
    });
    return oa.choices[0].message.content.trim();
  }
}

/* ──────────  Cerebras first, OpenAI fallback (for refine) ────── */
async function callLLM({ messages, preferJson = false, max_tokens = 512, temperature = 0.8, top_p = 1 }) {
  const base = {
    messages,
    max_completion_tokens: max_tokens,
    temperature,
    top_p,
    response_format: preferJson ? { type: 'json_object' } : { type: 'text' },
    stream: false
  };
  try {
    console.log('[Cerebras] chat.completions.create', JSON.stringify(base));
    const resp = await cerebras.chat.completions.create({
      model: 'llama-4-scout-17b-16e-instruct',
      ...base
    });
    return resp.choices[0].message.content;
  } catch (err) {
    console.error('[Cerebras] Error:', err.response?.status, err.response?.data || err.message);
    const transient = err?.response?.status === 429 || /rate limit|ECONN|timeout/i.test(err.message || '');
    if (!transient) throw err;
    console.warn('Cerebras unavailable → falling back to OpenAI');
    const oa = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      ...base,
      max_tokens
    });
    return oa.choices[0].message.content;
  }
}

/* ── Google search + retry (remove country code on 2nd try) ───── */
async function googleSearchWithRetry(query) {
  const run = async q => {
    const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}` +
                `&cx=${process.env.GOOGLE_CX}&q=${encodeURIComponent(q)}`;
    console.log('[GoogleSearch] GET', url);
    try {
      const { data } = await axios.get(url);
      return { items: data.items || [], queryUsed: q };
    } catch (err) {
      console.error('[GoogleSearch] Error:', err.response?.status, err.response?.data || err.message);
      throw err;
    }
  };
  // try 1
  let { items, queryUsed } = await run(query);
  if (items.length) return { items, queryUsed };
  // try 2 (remove country filter)
  const q2 = query.replace(/site:[a-z]{2}\.linkedin\.com\/in\//i, 'site:linkedin.com/in/');
  if (q2 !== query) {
    ({ items, queryUsed } = await run(q2));
  }
  return { items, queryUsed };
}

/* ── Regenerate X-Ray query if nothing found first pass ───────── */
async function regenerateXrayQuery(prevQuery, jobDescription) {
  const system = `The previous Google X-Ray query returned no results. Please refine it by removing restrictive filters (such as country-specific site filters) and adjusting keywords, boolean operators between keywords to broaden the search while staying relevant. 
Return only the new Google X-Ray query (plain text, no backticks or additional commentary at all).`;
  const user = `Job description:\n${jobDescription}\n\nPrevious query:\n${prevQuery}`;
  return (await callGemini({
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ],
    temperature: 1
  })).trim();
}

/* ───────────────────────────────────────────────────────────────
   POST /api/process-job
   ─────────────────────────────────────────────────────────────── */
app.post('/api/process-job', async (req, res) => {
  const { jobDescription } = req.body;
  console.log('Received job description:', jobDescription);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  try {
    /* ── 1. Generate Google X-Ray query via Gemini ──────────── */
    const xrayPrompt = `You are an expert at crafting Google X-Ray Search queries to find the most relevant LinkedIn profiles.
Think step-by-step to create an effective and compact query.

Step-by-Step Instructions:

1. Extract keywords:
- Job title
- 3 to 5 core skills or keywords
- Domain/industry (e.g., SaaS, Fintech, Automobile, etc.)
- Preferred or Target Company names (e.g., intitle:"Google" OR intitle:"Recruit CRM")
- Country or location (only if present and required)

2. Determine if this is a fresher/entry-level role:
- Check for phrases like: fresher, graduate, trainee, training program, entry-level
- If it is NOT a fresher role, use -intitle:"intern" -intitle:"student"
- If it IS a fresher role, do NOT include exclusions like -intitle:"intern" -intitle:"student"

4. Decide on company name:
   - Hiring company: If the user input implies the name of the hiring company (the company hiring for this role), NEVER include this company in the query.
   - Preferred or Target company backgrounds: If company names are mentioned as *preferred/target backgrounds* (not the hiring company), include each company using intitle:"[Company]", e.g., intitle:"google" OR intitle:"amazon".
   - If NO company names are mentioned, do NOT invent or guess any; do not include any intitle:"{company_name}"
   - Only use company names as described above; do not default to including known brands unless explicitly mentioned as preferred background or from target companies.

Important Notes:
- Use site:{country_code}.linkedin.com/in/ only when country is mentioned and not when only city or state is mentioned. E.g., site:de.linkedin.com/in OR fr.linkedin.com/in OR uk.linkedin.com/in, etc.
- Enclose multi-word phrases in quotes (e.g., "Product Manager", "Customer Success Manager", etc.)
- Use AND to add multiple required keywords, use OR to offer alternatives
- Use AND OR boolean in all the X-ray search queries for better results
- Important to keep the X-ray search query output minimal for optimal & high-quality Google search results
- Don't add 'location:{value}' rather just {value} when needed

Output Format:
- Output only the final Google search query (as plain text, no backticks or explanation)`;

    let xrayQuery = (await callGemini({
      messages: [
        { role: 'system', content: xrayPrompt },
        { role: 'user',   content: jobDescription }
      ],
      temperature: 0.8
    })).trim();

    // Early exit if Gemini returns an error (e.g., Error: 422)
    if (/^error\s*:\s*422/i.test(xrayQuery)) {
      res.write(`<p style="color:red;">X-Ray query could not be generated for this job description. (Error: 422)</p>`);
      res.end();
      return;
    }

    console.log('X-Ray Query:', xrayQuery);
    res.write(`<p><strong>X-Ray Query:</strong> ${xrayQuery}</p>`);

    /* ── 2. Google search with retry ─────────────────────────── */
    let { items } = await googleSearchWithRetry(xrayQuery);

    /* ── 3. If still no results → regenerate query & search again */
    if (!items.length) {
      const regenQuery = await regenerateXrayQuery(xrayQuery, jobDescription);
      xrayQuery = regenQuery;
      res.write(`<p><em>Regenerated X-Ray Query:</em> ${xrayQuery}</p>`);
      ({ items } = await googleSearchWithRetry(xrayQuery));
    }

    /* ── 4. Bail out if nothing found ───────────────────────── */
    if (!items.length) {
      res.write('<p style="color:red;">No candidates found after regenerating query.</p>');
      res.end();
      return;
    }

    /* ── 5. Preliminary candidate extraction ────────────────── */
    const prelim = items.map((item, idx) => {
      const og = item.pagemap?.metatags?.[0] || {};
      return {
        srNo: idx + 1,
        profile_picture: og['twitter:image'] || '',
        name: item.title || '',
        description: og['og:description'] || '',
        linkedin_url: item.link || '',
        company: parseCompany(item.title)
      };
    });

    /* ── 6. Stream HTML header ──────────────────────────────── */
    res.write(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <title>Candidate Results</title>
      <style>
        body{font-family:Arial, sans-serif;padding:20px}
        table{width:100%;border-collapse:collapse}
        th,td{padding:10px;border:1px solid #ddd;vertical-align:middle}
        th{background:#007bff;color:#fff}
        img{width:50px;height:50px;border-radius:50%;object-fit:cover}
        a{color:#007bff}
      </style></head><body>
      <h2>Candidate Results</h2>
      <table><thead><tr>
        <th>Sr No.</th><th>Profile Picture</th><th>Name</th>
        <th>Title</th><th>Company</th><th>Description</th><th>LI Profile</th>
      </tr></thead><tbody>`);

    /* ── 7. Refine each candidate (Cerebras → OpenAI fallback) ── */
    for (let i = 0; i < Math.min(10, prelim.length); i++) {
      const p = prelim[i];

      const systemMsg = `Extract candidate details in JSON format.
Return **only** a JSON object with exactly these keys:
  - name
  - title
  - company
  - summary
  - linkedin_url

Important Notes:
- Identify correct Candidate Name, Job Title or Position, and Company Name from the data. Do Not make up any information.
- If the summary has fewer than 50 words, expand it to about 200 words.
- Job Title or Position should NOT be exactly like the Header Title in the LinkedIn Profile but should be a more specific title.
- No additional commentary—JSON only.`;

      const userMsg = JSON.stringify(p, null, 2);

      let refined;
      try {
        const json = await callLLM({
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user',   content: userMsg }
          ],
          preferJson: true,
          max_tokens: 500,
          temperature: 0.2
        });
        refined = JSON.parse(json);
      } catch (err) {
        console.error(`Refine error (${i + 1}):`, err.message);
        refined = {
          name: p.name,
          title: '',
          company: p.company,
          summary: p.description,
          linkedin_url: p.linkedin_url
        };
      }

      refined.profile_picture = p.profile_picture || '';

      res.write(`<tr>
        <td>${i + 1}</td>
        <td><img src="${refined.profile_picture || 'https://via.placeholder.com/50'}" alt="Profile"></td>
        <td>${refined.name}</td>
        <td>${refined.title}</td>
        <td>${refined.company}</td>
        <td>${refined.summary}</td>
        <td><a href="${refined.linkedin_url}" target="_blank">LI Profile</a></td>
      </tr>`);
    }

    /* ── 8. Close HTML ───────────────────────────────────────── */
    res.write('</tbody></table></body></html>');
    res.end();
    console.log('Finished streaming HTML.');
  } catch (err) {
    console.error('Processing error:', err.message);
    if (res.headersSent) {
      res.write(`<tr><td colspan="7" style="color:red;">Error: ${err.message}</td></tr></tbody></table></body></html>`);
      return res.end();
    }
    res.status(500).send('Error processing job description.');
  }
});

/* ─────────────────────────────────────────────────────────────── */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});