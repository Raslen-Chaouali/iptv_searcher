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

// === Middleware to check secret password ===
function checkSecret(req, res, next) {
  const provided = req.query.secret || req.headers['x-scheduler-secret'];
  if (provided !== process.env.SCHEDULER_SECRET) {
    return res.status(403).json({ message: 'Forbidden: Invalid or missing secret' });
  }
  next();
}

// Swagger configuration
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
        url: 'https://iptv-searcher.onrender.com/api-docs',
      },
    ],
  },
  apis: ['./server.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ===============================
// Scheduler configuration - FIXED
// ===============================
let scheduler = null;
let isRunning = false;
const AUTO_TERMS = [
  'iptv', 'm3u', 'bein', 'بث مباشر',
  'world-iptv.club',
  'stbemuiptv.com',
  'iptv2live.com',
  'sultanovic.info',
  'tvappapk.com',
  'sat-forum.net'
];


// Store all active intervals to clear them properly
const activeIntervals = new Set();

const runAutoSearch = async () => {
  if (isRunning) {
    console.log('⏸️ Skipping run - previous still in progress');
    return;
  }

  const query = AUTO_TERMS.join(' ');
  console.log('🔄 Running scheduled search for:', query);

  isRunning = true;
  let allItems = [];

  try {
    // Google Search
    const API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
    const CSE_ID = process.env.GOOGLE_CSE_ID;

    if (API_KEY && CSE_ID) {
      for (let start = 1; start <= 91; start += 10) {
        try {
          const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${API_KEY}&cx=${CSE_ID}&num=10&start=${start}`;
          const response = await axios.get(url);
          const items = response.data.items || [];
          allItems.push(...items);
        } catch (err) {
          console.error('❌ Google Search Error for start', start, ':', err.message);
          if (err.response?.status === 429) {
            console.log('⚠️ Rate limited by Google, skipping further requests');
            break;
          }
        }
      }
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
    if (process.env.SERPAPI_API_KEY) {
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
    }
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

  isRunning = false;
  return { filtered, filename };
};

// ===============================
// API Endpoints - FIXED
// ===============================

/**
 * @swagger
 * /api/start-scheduler:
 *   post:
 *     summary: Start the automatic IPTV search scheduler
 */
app.post('/api/start-scheduler', checkSecret, async (req, res) => {
  // Clear any existing scheduler first
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
    console.log('🧹 Cleared existing scheduler before starting new one');
  }

  // Clear all active intervals
  activeIntervals.forEach(intervalId => {
    clearInterval(intervalId);
    console.log('🧹 Cleared interval:', intervalId);
  });
  activeIntervals.clear();

  try {
    // Run once immediately
    const result = await runAutoSearch();
    
    // Then schedule every 60 seconds with proper error handling
    scheduler = setInterval(async () => {
      try {
        await runAutoSearch();
      } catch (err) {
        console.error("❌ Scheduled run failed:", err.message);
        isRunning = false; // Ensure flag is reset even on error
      }
    }, 60000); // 60 seconds

    // Store the interval ID for proper cleanup
    activeIntervals.add(scheduler);

    console.log('✅ Scheduler started with interval ID:', scheduler);
    res.json({
      message: 'Scheduler started',
      results: result?.filtered || [],
      filename: result?.filename || 'no_file'
    });
  } catch (err) {
    console.error('❌ Error starting scheduler:', err.message);
    res.status(500).json({ message: 'Error starting scheduler', error: err.message });
  }
});

/**
 * @swagger
 * /api/stop-scheduler:
 *   post:
 *     summary: Stop the IPTV scheduler
 */
app.post('/api/stop-scheduler', checkSecret, (req, res) => {
  let stoppedCount = 0;

  // Clear the main scheduler
  if (scheduler) {
    clearInterval(scheduler);
    console.log('🛑 Stopped main scheduler:', scheduler);
    scheduler = null;
    stoppedCount++;
  }

  // Clear all active intervals
  activeIntervals.forEach(intervalId => {
    clearInterval(intervalId);
    console.log('🛑 Stopped interval:', intervalId);
    stoppedCount++;
  });
  activeIntervals.clear();

  // Reset running flag
  isRunning = false;

  if (stoppedCount > 0) {
    console.log('✅ Scheduler completely stopped. Cleared', stoppedCount, 'intervals');
    res.json({ message: `Scheduler stopped. Cleared ${stoppedCount} intervals` });
  } else {
    console.log('ℹ️ Scheduler was not running');
    res.status(400).json({ message: 'Scheduler not running' });
  }
});

/**
 * @swagger
 * /api/scheduler-status:
 *   get:
 *     summary: Check if the scheduler is currently running
 */
app.get('/api/scheduler-status', checkSecret, (req, res) => {
  const running = !!scheduler && activeIntervals.size > 0;
  console.log('📊 Status check - Running:', running, 'Active intervals:', activeIntervals.size);
  res.json({ 
    running: running,
    activeIntervals: activeIntervals.size,
    nextRun: running ? 'active' : 'none'
  });
});

/**
 * @swagger
 * /api/latest-results:
 *   get:
 *     summary: Get the latest saved search results from JSON
 */
app.get('/api/latest-results', checkSecret, (req, res) => {
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

// === Download latest JSON as file ===
app.get('/api/download-latest', checkSecret, (req, res) => {
  const files = fs.readdirSync('.')
    .filter(name => name.startsWith('auto_results_') && name.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    return res.status(404).json({ message: 'No results found to download' });
  }

  const latestFile = files[0];
  const filePath = path.join(__dirname, latestFile);

  res.download(filePath, latestFile, err => {
    if (err) {
      console.error('Error sending file:', err);
      res.status(500).send('Error downloading the file');
    }
  });
});

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (scheduler) {
    clearInterval(scheduler);
  }
  activeIntervals.forEach(intervalId => clearInterval(intervalId));
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
  console.log(`📚 Swagger docs available at http://localhost:${PORT}/api-docs`);
});
