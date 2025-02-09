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
 * 1. Uses OpenAI (gpt-4o) to generate an X-Ray search query using the exact system instructions.
 * 2. Uses that query to call the serper.dev API.
 * 3. Passes the full serper.dev JSON response to OpenAI (gpt-4o) to generate an HTML table.
 * 4. Returns the HTML table to the client.
 */
app.post('/api/process-job', async (req, res) => {
  const { jobDescription } = req.body;
  try {
    // -------------------------------------------------------------------
    // Step 1: Generate the X-Ray search query using OpenAI with gpt-4o.
    // -------------------------------------------------------------------
    const systemInstructions = `Construct a precise X-Ray search query based on the job_description to find suitable candidates on LinkedIn using serper.dev.

Analyze the job description to extract key skills, qualifications, experience, and attributes, then formulate a search query accordingly.

# Steps

1. **Analyze the Job Description**: 
   - Review the job_description.
   - Identify and extract key skills, qualifications, and experiences required for the role.
   - Highlight important keywords and phrases relevant to the job.
   
2. **Develop an X-Ray Search Strategy**: 
   - Construct a search query using the extracted keywords.
   - Use Boolean operators (AND, OR) to refine the search.
   - Ensure the query is suitable for use on serper.dev to X-Ray search LinkedIn profiles.

# Output Format

Provide only the search query as plain text, specifically structured for use with serper.dev for candidate searches on LinkedIn. Do not include any additional comments or remarks.

# Examples

**Input:**

job_description: The ideal candidate must have a minimum of 5 years of experience in software development with proficiency in Python and JavaScript. They should have a sound understanding of Agile methodologies and be familiar with cloud services such as AWS or Azure.

**Output:**

"\"software developer\" AND \"Python\" AND \"JavaScript\" AND \"Agile\" AND (\"AWS\" OR \"Azure\") site:linkedin.com/in"

# Notes

- Tailor the search query to include synonyms or alternative terms when applicable.
- Consider adding geographical locations or specific current companies for further refinement if needed.`;

    // Call OpenAI to generate the query.
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
    console.log("Full OpenAI Query Response:", JSON.stringify(openAIQueryResponse.data, null, 2));
    const xrayQuery = openAIQueryResponse.data.choices[0].message.content.trim();
    console.log('X-Ray Query:', xrayQuery);

    // -------------------------------------------------------------------
    // Step 2: Call the serper.dev API using your working Axios code.
    // -------------------------------------------------------------------
    const serperData = JSON.stringify({
      q: xrayQuery,
      num: 10
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

    // -------------------------------------------------------------------
    // Step 3: Pass the full serper.dev JSON response to OpenAI to generate an HTML table.
    // -------------------------------------------------------------------
    const htmlTableSystemInstruction = `Generate an HTML table with candidate details based on the following JSON data from serper.dev. The table should have the following columns: 
- Sr No.
- Name, 
- Title & Company, 
- LinkedIn Profile, 
- Skills.

# Don't add additional comments or remarks or characters like triple backticks just respond with the HTML
# Take all the candidates into the HTML table
# Make sure LinkedIn URL opens in a new tab`;
    
    const openAIHtmlResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4o-mini",
        messages: [
          { role: 'system', content: htmlTableSystemInstruction },
          { role: 'user', content: JSON.stringify(serperResponse.data, null, 2) }
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
    console.log("Full OpenAI HTML Table Response:", JSON.stringify(openAIHtmlResponse.data, null, 2));
    const htmlTable = openAIHtmlResponse.data.choices[0].message.content.trim();
    
    // -------------------------------------------------------------------
    // Step 4: Return the generated HTML table to the client.
    // -------------------------------------------------------------------
    res.json({ htmlTable });
  } catch (error) {
    console.error('Error processing job description:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Error processing job description.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});