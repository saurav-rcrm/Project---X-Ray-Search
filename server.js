// server.js
const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the "public" folder
app.use(express.static('public'));

/**
 * Endpoint: POST /api/process-job
 *
 * 1. Uses OpenAI (gpt-4o) to generate an X-Ray search query based on the job description.
 * 2. Uses that query to call the serper.dev API.
 * 3. Uses OpenAI (gpt-4o-mini) to standardize the candidate data into a JSON array.
 *    Each candidate object will have these keys: first_name, last_name, title, current_organization, linkedin, skills.
 * 4. Returns the standardized candidate data to the client.
 */
app.post('/api/process-job', async (req, res) => {
  const { jobDescription } = req.body;
  try {
    // Step 1: Generate the X-Ray search query using OpenAI (gpt-4o)
    const systemInstructions = `Construct a precise X-Ray search query based on the job_description to find suitable candidates on LinkedIn using serper.dev.

Analyze the job description to extract key skills, qualifications, experience, and attributes, then formulate a search query accordingly.

# Steps
1. **Analyze the Job Description**:
   - Review the job_description.
   - Identify and extract key skills, qualifications, and experiences.
2. **Develop an X-Ray Search Strategy**:
   - Construct a search query using Boolean operators (AND, OR).
   - Ensure the query is structured for use with serper.dev to search LinkedIn profiles.

# Output Format
Provide only the search query as plain text. Do not include any extra commentary.`;

    const openAIQueryResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4o",
        messages: [
          { role: 'system', content: systemInstructions },
          { role: 'user', content: jobDescription }
        ],
        max_tokens: 100,
        temperature: 1
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );
    const xrayQuery = openAIQueryResponse.data.choices[0].message.content.trim();
    console.log('X-Ray Query:', xrayQuery);

    // Step 2: Call the serper.dev API using Axios.
    const serperData = JSON.stringify({
      q: xrayQuery,
      num: 25
    });
    const serperConfig = {
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://google.serper.dev/search',
      headers: { 
        'X-API-KEY': process.env.SERPER_API_KEY, 
        'Content-Type': 'application/json'
      },
      data: serperData
    };

    const serperResponse = await axios.request(serperConfig);
    console.log("Full serper.dev Response:", JSON.stringify(serperResponse.data, null, 2));

    // Use serper.dev response as candidate data.
    let candidateData = serperResponse.data;
    // If no candidates are returned, assign an empty array.
    if (!candidateData.organic || candidateData.organic.length === 0) {
      console.warn("No candidate details returned from serper.dev. Returning no candidates.");
      candidateData = { candidates: [] };
    }
    
    // Step 3: Standardize candidate data using OpenAI (gpt-4o-mini)
    // Instruct it to return a JSON array of candidate objects with keys: first_name, last_name, title, current_organization, linkedin, skills.
    const jsonOutputSystemInstruction = `Generate a JSON array of candidate objects based on the following candidate data.
Each candidate object must have exactly these keys: "first_name", "last_name", "title", "current_organization", "linkedin", "skills".
Extract the first name and last name from the full name (split on the first space).
If separate fields for job title and company are available, assign them to "title" and "current_organization" respectively.
Use the candidate data exactly as provided. Do not include any additional commentary or formatting.`;

    const openAIJsonResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4o-mini",
        messages: [
          { role: 'system', content: jsonOutputSystemInstruction },
          { role: 'user', content: JSON.stringify(candidateData, null, 2) }
        ],
        max_tokens: 10000,
        temperature: 1,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );
    const jsonCandidateOutput = openAIJsonResponse.data.choices[0].message.content.trim();
    let standardizedCandidateData;
    try {
      standardizedCandidateData = JSON.parse(jsonCandidateOutput);
    } catch(e) {
      console.error("Error parsing standardized candidate data:", e);
      if (candidateData.candidates) {
        standardizedCandidateData = candidateData.candidates.map(cand => {
          let parts = (cand.name || "").trim().split(" ");
          return {
            first_name: parts.shift() || "",
            last_name: parts.join(" ") || "",
            title: cand.title || "",
            current_organization: cand.current_organization || "",
            linkedin: cand.linkedin || "",
            skills: Array.isArray(cand.skills) ? cand.skills.join(", ") : (cand.skills || "")
          };
        });
      } else {
        standardizedCandidateData = [];
      }
    }
    
    console.log("Standardized Candidate Data:", standardizedCandidateData);
    
    // Step 4: Return the standardized candidate data to the client.
    res.json({ candidateData: standardizedCandidateData });
  } catch (error) {
    console.error('Error processing job description:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Error processing job description.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});