// scripts/fetch-aws-datasets.js
const axios = require('axios');
const fs = require('fs');
const CryptoJS = require('crypto-js');

async function fetchFromAWS() {
  console.log('Fetching data from AWS Open Data Registry...');
  try {
    const { data } = await axios.get('https://github.com/opengeos/geospatial-data-catalogs/raw/master/aws_open_datasets.json');

    // Take the first 10 for now as an example
    const datasets = data.slice(0, 10);

    const content = datasets.map(d => ({
      name: d.Name,
      description: d.Description,
      free: 'Yes (Public Dataset)',
      limit: 'Unlimited',
      source: d.Documentation || '#', // Use Documentation URL if available, otherwise use a placeholder
    }));

    const hash = CryptoJS.SHA256(JSON.stringify(content)).toString();

    if (!fs.existsSync('src/content/auto')) {
      fs.mkdirSync('src/content/auto', { recursive: true });
    }

    fs.writeFileSync('src/content/auto/aws-datasets.json', JSON.stringify({ data: content, hash, updated: new Date().toISOString() }, null, 2));
    console.log('✅ AWS datasets fetched and saved to src/content/auto/aws-datasets.json');
  } catch (e) {
    console.error('❌ AWS fetch failed:', e.message);
  }
}

fetchFromAWS();
