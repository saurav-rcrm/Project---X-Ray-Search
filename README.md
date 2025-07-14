# X-Ray Search: AI-Powered Candidate Sourcing 🚀🔍

## Overview 📝

**X-Ray Search** is an AI-driven web application that helps recruiters and sourcers find top LinkedIn candidates using advanced Google X-Ray queries, LLMs (Gemini, OpenAI, Cerebras), and real-time result refinement. The app generates optimized search queries from job descriptions/recruiter's natural language query, fetches candidate profiles, and presents enriched, detailed results in a user-friendly interface.

---

## Features ✨

- 🤖 **AI-Powered X-Ray Query Generation:**
  - Converts job descriptions into effective Google X-Ray queries using Gemini (Google) LLM.
  - Automatically refines queries if no results are found.
- 🔎 **Google Custom Search Integration:**
  - Searches LinkedIn profiles using Google CSE.
- 🧑‍💼 **Candidate Data Enrichment:**
  - Uses Cerebras and OpenAI LLMs to extract, expand, and summarize candidate details.
- 🖥️ **Modern Web UI:**
  - Switch between AI-driven and traditional keyword search modes.
  - Real-time streaming of results with progress indicators and keyword highlighting.
- 🛡️ **Fallbacks for Reliability:**
  - If Gemini or Cerebras are unavailable, falls back to OpenAI for both query and candidate refinement.

---

## Tech Stack 🛠️

- **Backend:** Node.js, Express
- **Frontend:** Vanilla JS, HTML, CSS (no framework)
- **AI/LLM APIs:**
  - Google Gemini (via REST)
  - OpenAI (via SDK)
  - Cerebras (via SDK)
- **Search API:** Google Custom Search Engine (CSE)
- **Other:** dotenv, axios

---

## Setup & Installation ⚡

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd Project---X-Ray-Search
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create a `.env` file in the root directory with the following variables:**
   ```env
   PORT=10000 # or your preferred port
   GOOGLE_API_KEY=your_google_api_key
   GOOGLE_CX=your_google_cse_cx
   GEMINI_API_KEY=your_gemini_api_key
   OPENAI_API_KEY=your_openai_api_key
   CEREBRAS_API_KEY=your_cerebras_api_key
   ```
   - You must obtain API keys for [Google Custom Search](https://programmablesearchengine.google.com/), [Google Gemini](https://ai.google.dev/), [OpenAI](https://platform.openai.com/), and [Cerebras](https://cerebras.net/).

4. **Start the server:**
   ```bash
   node server.js
   ```
   The app will be available at [http://localhost:10000](http://localhost:10000) (or your chosen port).

---

## Usage 🕹️

1. **Open the app in your browser.**
2. **Choose a search mode:**
   - 🤖 **AI Search:** Paste a job description or candidate requirements. The app will generate and run an optimized X-Ray query.
   - 📝 **Traditional Search:** Manually enter job title, keywords, exclusions, and country.
3. **Click "Find Candidates"** (or use <kbd>Ctrl+Enter</kbd> / <kbd>⌘+Enter</kbd>).
4. **View results:**
   - 🧑‍💼 Candidate profiles are displayed in a table with name, title, company, summary, and LinkedIn link.
   - ✍️ Summaries are expanded and enriched using LLMs.
   - 🔄 If no results are found, the query is automatically refined and retried.

---

## Environment Variables 🌱

| Variable           | Description                        |
|--------------------|------------------------------------|
| `PORT`             | Port for the Express server         |
| `GOOGLE_API_KEY`   | Google Custom Search API key        |
| `GOOGLE_CX`        | Google Custom Search Engine CX      |
| `GEMINI_API_KEY`   | Google Gemini API key               |
| `OPENAI_API_KEY`   | OpenAI API key                     |
| `CEREBRAS_API_KEY` | Cerebras API key                   |

---

## Project Structure 🗂️

```
Project---X-Ray-Search/
├── server.js         # Express backend, API, LLM logic
├── package.json      # Dependencies and scripts
├── public/
│   ├── index.html    # Frontend UI
│   └── favicon.ico   # App icon
└── ...
```

---

## Notes 📌
- This project is for educational and research purposes. API usage may incur costs.
- Ensure your API keys are kept private and never committed to version control.
- For best results, use detailed job descriptions and valid API keys.

---