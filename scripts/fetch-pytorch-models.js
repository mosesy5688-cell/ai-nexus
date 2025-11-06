// scripts/fetch-pytorch-models.js
const axios = require('axios');
const fs = require('fs');
const CryptoJS = require('crypto-js');

async function fetchFromPyTorch() {
  console.log('Fetching data from PyTorch Hub...');
  try {
    // PyTorch Hub API is free and requires no key.
    const { data } = await axios.get('https://pytorch.org/hub/api');
    
    // Get the top 10 most starred models
    const models = data.sort((a, b) => b.stars - a.stars).slice(0, 10);

    const content = models.map(m => ({
      name: m.name,
      description: m.description,
      free: 'Yes (Open Source)',
      limit: 'Unlimited',
      source: `https://pytorch.org/hub/${m.repo}_${m.name}`,
    }));

    const hash = CryptoJS.SHA256(JSON.stringify(content)).toString();
    
    // Ensure the directory exists
    if (!fs.existsSync('src/content/auto')) {
      fs.mkdirSync('src/content/auto', { recursive: true });
    }

    fs.writeFileSync('src/content/auto/pytorch-models.json', JSON.stringify({ data: content, hash, updated: new Date().toISOString() }, null, 2));
    console.log('✅ PyTorch models fetched and saved to src/content/auto/pytorch-models.json');
  } catch (e) {
    console.error('❌ PyTorch fetch failed:', e.message);
  }
}

// Run the fetch function
fetchFromPyTorch();
