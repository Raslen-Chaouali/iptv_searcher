const express = require('express');
const axios = require('axios');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();
const PORT = 4000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Swagger configuration (unchanged)
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'IPTV Scheduler API',
      version: '1.0.0',
      description: 'API to schedule IPTV search tasks and fetch results',
    },
    servers: [
      {
        url: 'https://iptv-searcher.onrender.com/api-docs', // Change this to your deployed URL later
      },
    ],
  },
  apis: ['./server.js'], // Use inline Swagger comments
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Search configuration
let scheduler = null;
const AUTO_TERMS = ['iptv', 'm3u', 'bein', 'بث مباشر'];

// This function remains unchanged:
const runAutoSearch = async () => {
  const query = AUTO_TERMS.join(' ');
  console.log('🔄 Running scheduled search for:', query);

  let allItems = [];

  // Google Search
  try {
    const API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
    const CSE_ID = process.env.GOOGLE_CSE_ID;

    for (let start = 1; start <= 91; start += 10) {
      const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${API_KEY}&cx=${CSE_ID}&num=10&start=${start}`;
      const response = await axios.get(url);
      const items = response.data.items || [];
      allItems.push(...items);
    }
  } catch (err) {
    console.error('❌ Google Search Error:', err.message);
  }

  // Exa Search
  try {
    const { default: Exa } = await import('exa-js');
    const exa = new Exa(process.env.EXA_KEY);
    const exaResult = await exa.search(
      'This page shares working IPTV and M3U playlists for Bein Sports and more',
      { numResults: 100, useAutoprompt: true }
    );

    const exaItems = exaResult.results.map(r => ({
      title: r.title || r.url,
      link: r.url
    }));

    allItems.push(...exaItems);
  } catch (err) {
    console.error('❌ Exa Search Error:', err.message);
  }

  // SerpAPI Search
  try {
    const serpResponse = await axios.get('https://serpapi.com/search', {
      params: {
        q: query,
        api_key: process.env.SERPAPI_API_KEY,
        engine: 'google',
        num: 100
      }
    });

    const serpItems = serpResponse.data.organic_results || [];
    allItems.push(...serpItems);
  } catch (err) {
    console.error('❌ SerpAPI Error:', err.message);
  }

  // Normalize and filter
  const formatted = allItems.map(item => ({
    title: item.title || '',
    link: item.link || item.url || ''
  }));

  const uniqueMap = new Map();
  formatted.forEach(item => {
    if (item.link && !uniqueMap.has(item.link)) {
      uniqueMap.set(item.link, item);
    }
  });

  const uniqueResults = Array.from(uniqueMap.values());

  const filtered = uniqueResults.filter(item =>
    AUTO_TERMS.some(term => item.link.toLowerCase().includes(term.toLowerCase()))
  );

  const filename = `auto_results_${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(filtered, null, 2));
  console.log(`✅ Saved ${filtered.length} results to ${filename}`);

  // Return the filtered data and filename for use in API response
  return { filtered, filename };
};

/**
 * @swagger
 * /api/start-scheduler:
 *   post:
 *     summary: Start the automatic IPTV search scheduler
 *     responses:
 *       200:
 *         description: Scheduler started successfully
 *       400:
 *         description: Scheduler is already running
 */
app.post('/api/start-scheduler', async (req, res) => {
  if (scheduler) return res.status(400).json({ message: 'Scheduler already running' });

  // Run the search immediately, get results and filename
  const { filtered, filename } = await runAutoSearch();

  // Start the interval
  scheduler = setInterval(runAutoSearch, 60000);
  console.log('✅ Scheduler started');

  // Send back message AND the search results immediately for download
  res.json({
    message: 'Scheduler started',
    results: filtered,
    filename
  });
});

/**
 * @swagger
 * /api/stop-scheduler:
 *   post:
 *     summary: Stop the IPTV scheduler
 *     responses:
 *       200:
 *         description: Scheduler stopped successfully
 *       400:
 *         description: Scheduler is not running
 */
app.post('/api/stop-scheduler', (req, res) => {
  if (!scheduler) return res.status(400).json({ message: 'Scheduler not running' });

  clearInterval(scheduler);
  scheduler = null;
  console.log('🛑 Scheduler stopped');
  res.json({ message: 'Scheduler stopped' });
});

/**
 * @swagger
 * /api/scheduler-status:
 *   get:
 *     summary: Check if the scheduler is currently running
 *     responses:
 *       200:
 *         description: Scheduler status returned
 */
app.get('/api/scheduler-status', (req, res) => {
  res.json({ running: !!scheduler });
});

/**
 * @swagger
 * /api/latest-results:
 *   get:
 *     summary: Get the latest saved search results from JSON
 *     responses:
 *       200:
 *         description: JSON results returned
 *       404:
 *         description: No results found
 */
app.get('/api/latest-results', (req, res) => {
  const files = fs.readdirSync('.')
    .filter(name => name.startsWith('auto_results_') && name.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    return res.status(404).json({ message: 'No results found' });
  }

  const latestFile = files[0];
  const data = fs.readFileSync(path.join(__dirname, latestFile), 'utf-8');
  res.json(JSON.parse(data));
});

// === NEW ENDPOINT to serve latest results JSON as a file for download ===
app.get('/api/download-latest', (req, res) => {
  const files = fs.readdirSync('.')
    .filter(name => name.startsWith('auto_results_') && name.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    return res.status(404).json({ message: 'No results found to download' });
  }

  const latestFile = files[0];
  const filePath = path.join(__dirname, latestFile);

  // Set headers so browser downloads the file
  res.download(filePath, latestFile, err => {
    if (err) {
      console.error('Error sending file:', err);
      res.status(500).send('Error downloading the file');
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
  console.log(`📚 Swagger docs available at http://localhost:${PORT}/api-docs`);
});
