const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;
const path = require('path');

const GEMINI_API_KEY = process.env.YOUR_GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY'; // Fallback for local dev
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const KEYWORDS_PATH = path.join(__dirname, '../keywords.json');
const DATA_DIR = path.join(__dirname, '../src/data');
const KEYWORD_PAGES_DIR = path.join(__dirname, '../src/content/keywords');

async function generateMetaDescription(keyword, itemCount) {
  const prompt = `Create a compelling, SEO-friendly meta description of around 150 characters for a webpage listing ${itemCount} free AI tools and models for "${keyword}".`;
  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim().replace(/"/g, '');
  } catch (error) {
    console.error(`❌ Gemini failed for "${keyword}" meta description:`, error.message);
    return `Find the best free AI tools and models for ${keyword}. Explore our list of ${itemCount} resources.`; // Fallback
  }
}

async function main() {
  // 1. Read Keywords
  const keywordsJson = await fs.readFile(KEYWORDS_PATH, 'utf-8');
  const keywords = JSON.parse(keywordsJson);

  // 2. Read Data
  const dataFiles = await fs.readdir(DATA_DIR);
  let allData = [];
  for (const file of dataFiles) {
    if (file.endsWith('.json')) {
      const platformName = file.replace('.json', '');
      const filePath = path.join(DATA_DIR, file);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const platformData = JSON.parse(fileContent);
      allData.push(...platformData.map(item => ({ ...item, platform: platformName })));
    }
  }

  // 3. Process Each Keyword
  console.log('🚀 Starting keyword page generation...');
  for (const keyword of keywords) {
    const keywordSlug = keyword.toLowerCase().replace(/\s+/g, '-');
    console.log(`
🔍 Processing keyword: "${keyword}"`);

    // Find relevant items
    const relevantItems = allData.filter(item => {
      const lowerCaseKeyword = keyword.toLowerCase();
      const nameMatches = item.name.toLowerCase().includes(lowerCaseKeyword);
      const descriptionMatches = item.description && item.description.toLowerCase().includes(lowerCaseKeyword);
      const tagsMatch = item.tags && item.tags.some(tag => tag.toLowerCase().includes(lowerCaseKeyword));
      return nameMatches || descriptionMatches || tagsMatch;
    });

    if (relevantItems.length === 0) {
      console.log(`🟡 No items found for "${keyword}".`);
      continue;
    }

    console.log(`✅ Found ${relevantItems.length} items.`);

    // Generate content
    const description = await generateMetaDescription(keyword, relevantItems.length);
    const title = `Top Free AI Tools for ${keyword.replace(/\b\w/g, l => l.toUpperCase())}`;

    let content = `---
title: "${title}"
description: "${description}"
layout: ../../../layouts/KeywordPageLayout.astro
---

# ${title}

Explore our curated list of the best free AI models and tools for **${keyword}**.

`;

    for (const item of relevantItems) {
      content += `## ${item.name}\n`;
      content += `- **Platform:** ${item.platform.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}\n`;
      content += `- **Source:** [Link](${item.source})\n`;
      content += `- **Benchmark:** ${item.benchmark}\n\n`;
    }

    // Save the new page
    const pageDir = path.join(KEYWORD_PAGES_DIR, keywordSlug);
    await fs.mkdir(pageDir, { recursive: true });
    const filePath = path.join(pageDir, 'index.mdx');
    await fs.writeFile(filePath, content);
    console.log(`📄 Page created at ${filePath}`);
  }

  console.log('\n🎉 All keyword pages generated!');
}

main();
