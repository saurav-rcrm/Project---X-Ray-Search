/* ───────────────────────────────────────────────────────────────
   X-Ray Search → Google CSE → Cerebras / OpenAI → HTML stream
   ─────────────────────────────────────────────────────────────── */
const express = require('express');
const axios   = require('axios');
require('dotenv').config();

/* ─── LLM SDKs ────────────────────────────────────────────────── */
const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const cerebras = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

/* Shared wrapper → Cerebras first, OpenAI fallback */
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
    const resp = await cerebras.chat.completions.create({
      model: 'llama-4-scout-17b-16e-instruct',
      ...base
    });
    return resp.choices[0].message.content;
  } catch (err) {
    const transient = err?.response?.status === 429 || /rate limit|ECONN|timed out/i.test(err.message || '');
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

/* Google search + fallback without country code */
async function googleSearchWithRetry(query) {
  const run = async q => {
    const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}` +
                `&cx=${process.env.GOOGLE_CX}&q=${encodeURIComponent(q)}`;
    const { data } = await axios.get(url);
    return { items: data.items || [], queryUsed: q };
  };
  // try 1
  let { items, queryUsed } = await run(query);
  if (items.length) return { items, queryUsed };
  // try 2 (remove country)
  const q2 = query.replace(/site:[a-z]{2}\.linkedin\.com\/in\//i, 'site:linkedin.com/in/');
  if (q2 !== query) {
    ({ items, queryUsed } = await run(q2));
  }
  return { items, queryUsed };
}

/* Regenerate X-Ray query if none of the searches returned hits */
async function regenerateXrayQuery(prevQuery, jobDescription) {
  const system = `The previous Google X-Ray query returned no results. Please refine it by removing restrictive filters (such as country-specific site filters) and adjusting keywords, boolean operators between keywords to broaden the search while staying relevant. 
Return only the new Google X-Ray query (plain text, no backticks or additional commentary at all).`;
  const user = `Job description:\n${jobDescription}\n\nPrevious query:\n${prevQuery}`;
  return (await callLLM({
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ],
    max_tokens: 1000,
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
    /* ── 1. Generate Google X-Ray query ─────────────────────── */
    const xrayPrompt = `You are an expert at crafting Google X-Ray Search queries to find the most relevant LinkedIn profiles.
Think step-by-step to create an effective and compact query.

Step-by-Step Instructions:
1. Extract:
- Job title
- 3 to 5 core skills or keywords
- Domain/industry (e.g., SaaS, Fintech, Automobile, etc.)
- Country or location (if present)
- Don't add 'location:{value}' rather just {value} when needed
- Preferred or Target Company names (mentioned in the JD)

2. Determine if this is a fresher/entry-level role:
- Check for phrases like: fresher, graduate, trainee, training program, entry-level

3. Decide on exclusions:
- If it is NOT a fresher role, use -intern -student
- If it IS a fresher role, do NOT include exclusions like -intern -student

4. Decide on company usage:
- If the company mentioned is the hiring company, do NOT include it
- If other companies are mentioned as preferred backgrounds, include them using intitle:{company}
- If the job description does NOT mention any company names, do NOT include or guess any.

5. Construct the X-Ray query using:
- Include the job title, skills, and the domain/industry if available
- site:{country_code}.linkedin.com/in/
- Use {country_code} only when country is mentioned and not when only city or state is mentioned
- Enclose multi-word phrases in quotes (e.g., "Product Manager", etc.)
- Use AND to add multiple required keywords, use OR to offer alternatives
- Use AND OR boolean in all the X-ray search query

Output Format:
- Output only the final Google search query (as plain text, no backticks or explanation).`;

    let xrayQuery = (await callLLM({
      messages: [
        { role: 'system', content: xrayPrompt },
        { role: 'user',   content: jobDescription }
      ],
      max_tokens: 500,
      temperature: 0.8
    })).trim();

    console.log('X-Ray Query:', xrayQuery);
    res.write(`<p><strong>X-Ray Query:</strong> ${xrayQuery}</p>`);

    /* ── 2. Google search with retry ─────────────────────────── */
    let { items, queryUsed } = await googleSearchWithRetry(xrayQuery);

    /* ── 3. If still no results → regenerate query & search again */
    if (!items.length) {
      xrayQuery = await regenerateXrayQuery(xrayQuery, jobDescription);
      res.write(`<p><em>Regenerated X-Ray Query:</em> ${xrayQuery}</p>`);
      ({ items, queryUsed } = await googleSearchWithRetry(xrayQuery));
    }

    /* ── 4. Bail out if nothing found ───────────────────────── */
    if (!items.length) {
      res.write('<p style="color:red;">No candidates found after regenerating query.</p>');
      res.end();
      return;
    }
    if (queryUsed !== xrayQuery) {
      res.write(`<p><em>Retried with generalized query:</em> ${queryUsed}</p>`);
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

    /* ── 7. Refine each candidate ───────────────────────────── */
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
- Identify correct Name, Job Title, and Company from the data.
- If the summary has fewer than 50 words, expand it to about 200 words.
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