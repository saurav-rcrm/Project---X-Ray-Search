// server.js
const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware to parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the "public" folder
app.use(express.static('public'));

/**
 * Helper function: Parse company name from candidate title.
 * This function assumes the candidate title contains hyphen-separated segments
 * and that the company is in one of the segments. Adjust as needed.
 */
function parseCompany(title) {
  if (!title) return "";
  const parts = title.split(" - ");
  // For example, if title is "John Doe - Senior Product Manager - Microsoft", company is "Microsoft"
  return parts.length >= 3 ? parts[parts.length - 1].trim() : "";
}

/**
 * Helper function: Count words in a text.
 */
function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * For each candidate, call OpenAI individually to extract refined candidate details.
 * The prompt instructs OpenAI to return a JSON object with keys: 
 * name, title, company, summary, linkedin_url.
 * We'll merge the profile_picture from the original filtered result.
 */
async function refineCandidate(candidate) {
  const refinePrompt = `Extract candidate details in JSON format from the following candidate information.
Return a JSON object with exactly these keys:
  - name
  - title
  - company
  - summary
  - linkedin_url

Candidate information (as JSON):
${JSON.stringify(candidate, null, 2)}

Notes:
- Use the candidate information to determine the correct Name, Title, and Company.
- If any field is missing, return it as an empty string.
- Use the original description to generate a detailed summary (if the description has fewer than 50 words, generate a summary of about 200 words).
- Do not include any additional commentary or formatting.
`;
  console.log("Refining candidate details for:", candidate.name);
  let refinedCandidateText = "";
  try {
    // OpenAI streaming call for refining this candidate's details
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: 'system', content: refinePrompt }
      ],
      max_tokens: 1500,
      temperature: 1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      response_format: { type: "text" },
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) {
        const content = chunk.choices[0].delta.content;
        process.stdout.write(content);
        refinedCandidateText += content;
      }
    }
    console.log("\nFinished refining candidate.");
    // Try to parse the refined candidate JSON.
    let refined = JSON.parse(refinedCandidateText.trim());
    // Ensure profile_picture is included from original data if not provided.
    if (!refined.profile_picture) {
      refined.profile_picture = candidate.profile_picture || "";
    }
    return refined;
  } catch (error) {
    console.error("Error refining candidate:", error.response ? error.response.data : error.message);
    // Fallback: return original candidate fields (with empty refined fields)
    return {
      name: candidate.name || "",
      title: "",
      company: parseCompany(candidate.name),
      summary: candidate.description || "",
      linkedin_url: candidate.linkedin_url || "",
      profile_picture: candidate.profile_picture || ""
    };
  }
}

/**
 * Endpoint: POST /api/process-job
 * 
 * Steps:
 * 1. Generate an x-ray search query using your provided prompt (via OpenAI).
 * 2. Call the Google Custom Search API with that query.
 * 3. Filter the API response to extract preliminary candidate details:
 *    - profile_picture (from og:image)
 *    - name (from title)
 *    - description (from og:description)
 *    - linkedin_url (from item.link)
 *    - company (parsed from title)
 * 4. For each candidate (up to 10), make an individual OpenAI streaming call to refine details.
 * 5. Stream each candidate's HTML table row (with columns: Sr No., Profile Picture, Name, Title, Company, Description, LI Profile) to the client.
 */
app.post('/api/process-job', async (req, res) => {
  const { jobDescription } = req.body;
  console.log("Received job description:", jobDescription);

  // Set response header for HTML streaming
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  try {
    // Step 1: Generate x-ray search query using OpenAI with your prompt
    const xrayPrompt = `You are an expert at crafting Google X-Ray Search queries to find the most relevant LinkedIn profiles.
Think step-by-step to create an effective and compact query.

Step-by-Step Instructions:
1. Extract:
- Job title
- 3 to 5 core skills or keywords
- Domain/industry (e.g., SaaS, Fintech, Automobile, etc.)
- Country or location (if present)
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
- Enclose multi-word phrases in quotes (e.g., "Product Manager", etc.)
- Use AND only when needed, use OR to offer alternatives

Output Format:
- Output only the final Google search query (as plain text, no backticks or explanation).`;

    console.log("Generating x-ray search query...");
    const openAIQueryResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4o-mini",
        messages: [
          { role: 'system', content: xrayPrompt },
          { role: 'user', content: jobDescription }
        ],
        max_tokens: 1000,
        temperature: 1,
        response_format: { type: "text" }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );
    const xrayQuery = openAIQueryResponse.data.choices[0].message.content.trim();
    console.log("X-Ray Query:", xrayQuery);
    res.write(`<p><strong>X-Ray Query:</strong> ${xrayQuery}</p>`);

    // Step 2: Call the Google Custom Search API
    const googleUrl = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CX}&q=${encodeURIComponent(xrayQuery)}`;
    console.log("Calling Google Custom Search API:", googleUrl);
    const googleResponse = await axios.get(googleUrl);
    console.log("Google API Response received.");

    // Step 3: Filter the response to extract preliminary candidate details
    const preliminaryCandidates = (googleResponse.data.items || []).map((item, idx) => {
      let ogData = {};
      if (item.pagemap && item.pagemap.metatags && item.pagemap.metatags.length > 0) {
        ogData = item.pagemap.metatags[0];
      }
      const candidateName = item.title || "";
      return {
        srNo: idx + 1,
        profile_picture: ogData["twitter:image"] || "",
        name: candidateName,
        description: ogData["og:description"] || "",
        linkedin_url: item.link || "",
        // We may extract company from the candidate name; refine if needed.
        company: parseCompany(candidateName)
      };
    });
    console.log("Preliminary Candidates:", preliminaryCandidates);

    // Begin streaming the HTML table header
    res.write(`<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Candidate Results</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 10px; border: 1px solid #ddd; vertical-align: middle; }
          th { background: #007BFF; color: #fff; }
          img { width: 50px; height: 50px; border-radius: 50%; object-fit: cover; }
          a { color: #007BFF; }
        </style>
      </head>
      <body>
        <h2>Candidate Results</h2>
        <table>
          <thead>
            <tr>
              <th>Sr No.</th>
              <th>Profile Picture</th>
              <th>Name</th>
              <th>Title</th>
              <th>Company</th>
              <th>Description</th>
              <th>LI Profile</th>
            </tr>
          </thead>
          <tbody>
    `);

    // Step 4: Process each candidate individually and stream its table row
    for (let i = 0; i < Math.min(10, preliminaryCandidates.length); i++) {
      let prelim = preliminaryCandidates[i];
      console.log(`Processing candidate ${i+1}: ${prelim.name}`);

      // Build a prompt for refining this candidate's details
      const refinePrompt = `Extract candidate details in JSON format from the following candidate information.
Return a JSON object with exactly these keys:
  - name
  - title
  - company
  - summary
  - linkedin_url

Candidate information (in JSON):
${JSON.stringify(prelim, null, 2)}

Notes:
- Use the candidate information to determine the correct Name, Title, and Company.
- If the description (summary) is less than 50 words, expand it to about 200 words.
- Do not include any additional commentary or formatting.`;

      // Stream the refined candidate details from OpenAI
      console.log(`Refining candidate ${i+1} details...`);
      let refinedCandidateText = "";
      try {
        const candidateStream = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: 'system', content: refinePrompt }
          ],
          max_tokens: 1500,
          temperature: 1,
          top_p: 1,
          frequency_penalty: 0,
          presence_penalty: 0,
          response_format: { type: "text" },
          stream: true,
        });
        for await (const chunk of candidateStream) {
          if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) {
            const content = chunk.choices[0].delta.content;
            process.stdout.write(content);
            refinedCandidateText += content;
          }
        }
      } catch (error) {
        console.error(`Error refining candidate ${i+1}:`, error.response ? error.response.data : error.message);
        refinedCandidateText = JSON.stringify({
          name: prelim.name,
          title: "",
          company: prelim.company,
          summary: prelim.description,
          linkedin_url: prelim.linkedin_url
        });
      }

      // Parse the refined candidate details
      let refined;
      try {
        refined = JSON.parse(refinedCandidateText.trim());
      } catch (e) {
        console.error(`Error parsing candidate ${i+1} refined JSON:`, e);
        refined = {
          name: prelim.name,
          title: "",
          company: prelim.company,
          summary: prelim.description,
          linkedin_url: prelim.linkedin_url
        };
      }
      // Ensure profile_picture is carried over from preliminary data
      refined.profile_picture = prelim.profile_picture || "";

      // Build the HTML table row for this candidate
      let rowHtml = `
        <tr>
          <td>${i + 1}</td>
          <td><img src="${refined.profile_picture || 'https://via.placeholder.com/50'}" alt="Profile Picture"></td>
          <td>${refined.name}</td>
          <td>${refined.title}</td>
          <td>${refined.company}</td>
          <td>${refined.summary}</td>
          <td><a href="${refined.linkedin_url}" target="_blank">LI Profile</a></td>
        </tr>
      `;
      res.write(rowHtml);
      console.log(`Streamed candidate ${i+1} row.`);
    }

    // End the HTML table and document
    res.write(`
          </tbody>
        </table>
      </body>
      </html>
    `);
    console.log("Finished streaming HTML table.");
    res.end();
  } catch (error) {
    console.error("Error processing job description:", error.response ? error.response.data : error.message);
    res.status(500).send("Error processing job description.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});